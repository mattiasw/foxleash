import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { crc32 } from "node:zlib";
import {
  auditAdvisories,
  type Bump,
  breakingChangeEntries,
  CommandError,
  checkArtifacts,
  checkBuilt,
  checkChangelog,
  checkListing,
  checkPostBump,
  checkPostRoll,
  checkPrePush,
  checkPreRoll,
  checkProtocol,
  compareVersions,
  type Env,
  escapeControls,
  type Finding,
  latestTag,
  listingBullets,
  localDate,
  mainCiRuns,
  nextVersion,
  parseArgs,
  parseChangelog,
  parseSlug,
  realEnv,
  requiredBump,
  runCli,
  worktreeChanges,
} from "./check-release.ts";

const ROOT = "/repo";
const HEAD = "a".repeat(40);
const OTHER = "c".repeat(40);
const TAG_SHA = "b".repeat(40);
const TODAY = "2026-10-18";
const ORIGIN_URL = "git@github.com:owner/repo.git";
const WORKSPACES = ["apps/extension", "apps/server", "packages/protocol", "packages/tsconfig"];

const key = (...parts: string[]): string => JSON.stringify(parts);
const TAGS = key(
  "git",
  "tag",
  "--list",
  "--no-column",
  "--merged",
  "HEAD",
  "--sort=-v:refname",
  "v*",
);
const URL = key("git", "remote", "get-url", "origin");
const PUSH_URL = key("git", "remote", "get-url", "--push", "--all", "origin");
const FETCH = key(
  "git",
  "fetch",
  "--no-prune",
  "--no-prune-tags",
  "origin",
  "+refs/heads/main:refs/remotes/origin/main",
);
const BRANCH = key("git", "rev-parse", "--abbrev-ref", "HEAD");
const REV_HEAD = key("git", "rev-parse", "HEAD");
const REV_ORIGIN = key("git", "rev-parse", "refs/remotes/origin/main");
const COUNTS = key("git", "rev-list", "--left-right", "--count", "refs/remotes/origin/main...HEAD");
const STATUS = key(
  "git",
  "status",
  "--porcelain",
  "--untracked-files=all",
  "--ignore-submodules=none",
);
const LS_FILES = key("git", "ls-files", "-v");
const ghRuns = (sha: string): string =>
  key(
    "gh",
    "api",
    "--hostname",
    "github.com",
    `repos/owner/repo/actions/runs?head_sha=${sha}&per_page=100`,
  );
const GH = ghRuns(HEAD);
const AUDIT = key(
  "npm",
  "audit",
  "--json",
  "--package-lock-only",
  "--audit-level=none",
  "--include=dev",
  "--include=optional",
  "--include=peer",
  "--offline=false",
  "--workspaces",
  "--include-workspace-root",
);
const SHOW_CHANGELOG = key("git", "show", "HEAD:CHANGELOG.md");
const SHOW_PACKAGE = key("git", "show", "HEAD:package.json");
const SHOW_ORIGIN_PACKAGE = key("git", "show", "refs/remotes/origin/main:package.json");
const ANCESTOR = key("git", "merge-base", "--is-ancestor", "refs/remotes/origin/main", "HEAD");
const MERGES = key("git", "rev-list", "--merges", "refs/remotes/origin/main..HEAD");
const MAIN_AHEAD = key("git", "rev-list", "refs/remotes/origin/main..refs/heads/main");
const LOG = key(
  "git",
  "log",
  "--no-show-signature",
  "--format=%s",
  "refs/remotes/origin/main..HEAD",
);
const POINTS_AT = key("git", "tag", "--points-at", "HEAD", "--no-column");
const DIFF_TREE = key(
  "git",
  "diff-tree",
  "-r",
  "--name-only",
  "--no-renames",
  "refs/remotes/origin/main",
  "HEAD",
);
const show = (ref: string, file: string): string => key("git", "show", `${ref}:${file}`);
const VERSION_FILES = [
  "package.json",
  ...WORKSPACES.map((dir) => `${dir}/package.json`),
  "package-lock.json",
];
const lsRemote = (tag: string): string =>
  key("git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`);
const tagList = (tag: string): string => key("git", "tag", "--list", tag);
const revTag = (tag: string): string => key("git", "rev-parse", `refs/tags/${tag}`);
const catFile = (tag: string): string => key("git", "cat-file", "-t", `refs/tags/${tag}`);
const unzipManifest = (xpi: string): string => key("unzip", "-UU", "-p", xpi, "manifest.json");
const unzipEntry = (archive: string, name: string): string =>
  key("unzip", "-UU", "-p", archive, name);
const catBlob = (sha: string, file: string): string =>
  key("git", "cat-file", "blob", `${sha}:${file}`);
const lsTree = (sha: string, nameOnly: boolean): string =>
  key("git", "ls-tree", "-r", "-z", ...(nameOnly ? ["--name-only"] : []), "--full-tree", sha);
const SOURCE_TEMPLATE = "bin/amo-source-readme.md";
const SOURCE_ZIP = "artifacts/foxleash-source-0.2.0.zip";
const SOURCE_FILES: Record<string, string> = {
  ".nvmrc": "24\n",
  "apps/extension/manifest.json": json({ manifest_version: 3 }),
  "apps/extension/src/background.ts": "start();\n",
};

const INTRO = "# Changelog\n\nAll notable changes to this project are documented here.";
const ENTRIES = [
  "### Added",
  "",
  "- The extension opens tabs for your agent, keeping each session's tabs",
  "  in its own tab group.",
  "- An MCP server gives your agent the tab tools.",
].join("\n");
const OLD_SECTION = "## [0.1.0] - 2026-10-01\n\n### Added\n\n- The first release.";

const MANIFEST = "apps/extension/manifest.json";
const PROTOCOL = "packages/protocol/src/index.ts";
const LISTING = "docs/amo/listing.md";
const CLAIMS = "docs/amo/listing-claims.json";
const AMO_SOURCES = "bin/amo-source-files.txt";
const FIXTURE_MANIFEST = {
  manifest_version: 3,
  name: "Foxleash",
  browser_specific_settings: {
    gecko: { data_collection_permissions: { required: ["websiteContent"] } },
  },
  permissions: ["tabs", "storage"],
  host_permissions: ["<all_urls>"],
};
const FIXTURE_LISTING = [
  "# AMO listing",
  "",
  "## Summary",
  "",
  "Lets an agent use Firefox.",
  "",
  "## Description",
  "",
  "Foxleash lets an agent use Firefox.",
  "",
  "The agent can:",
  "",
  "- open tabs and navigate them,",
  "- read pages.",
  "",
  "Each session acts only on tabs in its group. Foxleash limits what a fooled agent can do:",
  "",
  "- The approval can only come from your click.",
  "- Tool results mark page content as untrusted.",
  "",
  "What protects you:",
  "",
  "- it acts only on tabs in its group.",
  "",
  "## Permissions",
  "",
  "Why Foxleash requests each permission in its manifest:",
  "",
  "- tabs: lists the agent's tabs.",
  "- storage: keeps the settings.",
  "- <all_urls>: works on any approved site.",
  "",
  "## Data collection and handling",
  "",
  "- Website content (websiteContent): page text.",
  "- Browsing activity (browsingActivity): tab URLs.",
  "",
  "## Compatibility",
  "",
  "Linux only; this is not about (authenticationInfo).",
  "",
].join("\n");
const FIXTURE_CLAIMS = {
  note: "The claims of the fixture listing.",
  capabilities: [
    { listing: "open tabs and navigate them", tools: ["tabs_list", "navigate"] },
    { listing: "read pages", tools: ["read_page"] },
  ],
  safeguards: [
    {
      listing: "The approval can only come from your click",
      evidence: [{ file: "apps/extension/src/approval.ts", contains: "approvedByClick" }],
    },
    {
      listing: "Tool results mark page content as untrusted",
      evidence: [
        { file: "apps/extension/src/tools.ts", contains: "untrusted" },
        { file: MANIFEST, lacks: "userScripts" },
      ],
    },
    {
      listing: "acts only on tabs in its group",
      evidence: [{ file: "apps/extension/src/tools.ts", contains: "group" }],
    },
  ],
};
const FIXTURE_TOOLS = ["navigate", "read_page", "tabs_list"];
const EVIDENCE_FILES: Record<string, string> = {
  "apps/extension/src/approval.ts": "export const approvedByClick = true;\n",
  "apps/extension/src/tools.ts":
    "// Marks page content as untrusted, in the session's group only.\n",
};
const stagedEntry = (file: string, mode = "100644"): string =>
  `${mode} ${"d".repeat(40)} 0\t${file}\0`;
const lsStaged = (file: string): string => key("git", "ls-files", "-s", "-z", "--", file);
const diffSince = (tag: string, file: string): string =>
  key(
    "git",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    `refs/tags/${tag}`,
    "--",
    file,
  );

type Reply = string | Buffer | CommandError;
type Tree = { files: Record<string, string>; commands: Record<string, Reply>; tools?: string[] };
type FakeEnv = Env & { calls: string[][] };

function changelog(...sections: string[]): string {
  return `${[INTRO, ...sections].join("\n\n")}\n`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The protocol source with the given numbers; no `oldest` is a file from before the window. */
function protocolSource(current: number, oldest?: number): string {
  return [
    "/** Bump when a message shape or method contract changes incompatibly. */",
    `export const PROTOCOL_VERSION = ${current};`,
    "",
    ...(oldest === undefined
      ? []
      : [
          "/** The oldest protocol version the extension still serves. */",
          `export const OLDEST_SERVED_PROTOCOL = ${oldest};`,
          "",
        ]),
    'export const NATIVE_HOST_NAME = "fixture";',
    "",
  ].join("\n");
}

function packageFiles(version: string, overrides: Record<string, string> = {}): Tree["files"] {
  const at = (source: string): string => overrides[source] ?? version;
  const files: Tree["files"] = {
    "package.json": json({
      name: "fixture",
      version: at("package.json"),
      workspaces: ["apps/*", "packages/*"],
    }),
    [MANIFEST]: json(FIXTURE_MANIFEST),
    "package-lock.json": json({
      name: "fixture",
      version: at("lock"),
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: at('lock ""') },
        ...Object.fromEntries(
          WORKSPACES.map((dir) => [dir, { name: dir, version: at(`lock ${dir}`) }]),
        ),
      },
    }),
  };
  for (const dir of WORKSPACES) {
    files[`${dir}/package.json`] = json({ name: dir, version: at(`${dir}/package.json`) });
  }
  return files;
}

function ciRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    name: "CI",
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: HEAD,
    head_repository: { full_name: "owner/repo" },
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-10-18T10:00:00Z",
    ...overrides,
  };
}

function runs(...list: Record<string, unknown>[]): string {
  return JSON.stringify({ total_count: list.length, workflow_runs: list });
}

/** The listing, its claims, their evidence and the tools, all in agreement. */
function listingFiles(): Tree["files"] {
  return { [LISTING]: FIXTURE_LISTING, [CLAIMS]: json(FIXTURE_CLAIMS), ...EVIDENCE_FILES };
}

function listingCommands(): Tree["commands"] {
  return Object.fromEntries(
    [MANIFEST, ...Object.keys(EVIDENCE_FILES)].map((file) => [lsStaged(file), stagedEntry(file)]),
  );
}

/** The replies of the drift check when nothing changed since `tag`. */
function driftCommands(tag: string): Tree["commands"] {
  return {
    [diffSince(tag, MANIFEST)]: "",
    [diffSince(tag, LISTING)]: "",
    [diffSince(tag, AMO_SOURCES)]: "",
    [show(`refs/tags/${tag}`, MANIFEST)]: json(FIXTURE_MANIFEST),
  };
}

/** The reply of the protocol check at `tag`, a release from before the window. */
function protocolCommands(tag: string): Tree["commands"] {
  return { [show(`refs/tags/${tag}`, PROTOCOL)]: protocolSource(3) };
}

/** Clean, synced main with a green CI run and no tag: the state before the first release. */
function firstReleaseTree(): Tree {
  return {
    tools: [...FIXTURE_TOOLS],
    files: {
      ...packageFiles("0.1.0"),
      ...listingFiles(),
      [PROTOCOL]: protocolSource(6, 3),
      "CHANGELOG.md": changelog(`## [Unreleased]\n\n${ENTRIES}`),
    },
    commands: {
      ...listingCommands(),
      [TAGS]: "",
      [URL]: ORIGIN_URL,
      [PUSH_URL]: ORIGIN_URL,
      [FETCH]: "",
      [BRANCH]: "main",
      [REV_HEAD]: HEAD,
      [REV_ORIGIN]: HEAD,
      [STATUS]: "",
      [LS_FILES]: "H CHANGELOG.md\nH package.json",
      [tagList("v0.1.0")]: "",
      [lsRemote("v0.1.0")]: "",
      [GH]: runs(ciRun()),
      [AUDIT]: json(auditReport()),
    },
  };
}

/** The same with v0.1.0 released (also on origin) and new Unreleased entries. */
function secondReleaseTree(): Tree {
  const tree = firstReleaseTree();
  tree.files["CHANGELOG.md"] = changelog(`## [Unreleased]\n\n${ENTRIES}`, OLD_SECTION);
  Object.assign(tree.commands, {
    [TAGS]: "v0.1.0",
    [lsRemote("v0.1.0")]: `${TAG_SHA}\trefs/tags/v0.1.0`,
    [revTag("v0.1.0")]: TAG_SHA,
    [tagList("v0.2.0")]: "",
    [lsRemote("v0.2.0")]: "",
    ...driftCommands("v0.1.0"),
    ...protocolCommands("v0.1.0"),
  });
  return tree;
}

function postRollTree(release: "first" | "second"): Tree {
  const tree = release === "first" ? firstReleaseTree() : secondReleaseTree();
  const version = release === "first" ? "0.1.0" : "0.2.0";
  const older = release === "first" ? [] : [OLD_SECTION];
  tree.commands[SHOW_CHANGELOG] = tree.files["CHANGELOG.md"] ?? "";
  tree.files["CHANGELOG.md"] = changelog(
    "## [Unreleased]",
    `## [${version}] - ${TODAY}\n\n${ENTRIES}`,
    ...older,
  );
  tree.commands[STATUS] = " M CHANGELOG.md";
  return tree;
}

function postBumpTree(release: "first" | "second"): Tree {
  const tree = postRollTree(release);
  tree.commands[SHOW_PACKAGE] = tree.files["package.json"] ?? "";
  if (release === "first") {
    tree.commands[STATUS] = "";
  } else {
    Object.assign(tree.files, packageFiles("0.2.0"));
    tree.commands[STATUS] = [
      " M package.json",
      ...WORKSPACES.map((dir) => ` M ${dir}/package.json`),
      " M package-lock.json",
    ].join("\n");
  }
  return tree;
}

function prePushTree(release: "first" | "second"): Tree {
  const tree = postBumpTree(release);
  const version = release === "first" ? "0.1.0" : "0.2.0";
  const tag = `v${version}`;
  const xpi = `artifacts/foxleash-${version}.xpi`;
  tree.files[xpi] = "zip";
  tree.files[`artifacts/foxleash-source-${version}.zip`] = "zip";
  const released = packageFiles("0.1.0");
  Object.assign(tree.commands, {
    [TAGS]: release === "first" ? "v0.1.0" : "v0.2.0\nv0.1.0",
    [BRANCH]: `release/${version}`,
    [MAIN_AHEAD]: "",
    [STATUS]: "",
    [REV_HEAD]: HEAD,
    [REV_ORIGIN]: OTHER,
    [ghRuns(OTHER)]: runs(ciRun({ head_sha: OTHER })),
    [ANCESTOR]: "",
    [MERGES]: "",
    [LOG]:
      release === "first"
        ? "Update changelog for 0.1.0"
        : "Bump version to 0.2.0\nUpdate changelog for 0.2.0",
    [SHOW_ORIGIN_PACKAGE]: released["package.json"],
    [POINTS_AT]: tag,
    [catFile(tag)]: "tag",
    [lsRemote(tag)]: "",
    [unzipManifest(xpi)]: Buffer.from(json({ manifest_version: 3, version })),
    ...sourceCommands(version, SOURCE_FILES),
    [DIFF_TREE]:
      release === "first" ? "CHANGELOG.md" : ["CHANGELOG.md", ...VERSION_FILES].join("\n"),
  });
  if (release === "second") {
    tree.commands[show("refs/remotes/origin/main", "CHANGELOG.md")] =
      tree.commands[SHOW_CHANGELOG] ?? "";
    for (const file of VERSION_FILES) {
      tree.commands[show("refs/remotes/origin/main", file)] = released[file] ?? "";
      tree.commands[show("HEAD", file)] = tree.files[file] ?? "";
    }
  }
  return tree;
}

/**
 * The replies of the source archive comparison when `artifacts/` holds the archive of `files`,
 * the files HEAD ships, tagged `v<version>`.
 */
function sourceCommands(version: string, files: Record<string, string>): Tree["commands"] {
  const source = `artifacts/foxleash-source-${version}.zip`;
  const tracked = [".gitignore", ...Object.keys(files), "CHANGELOG.md", SOURCE_TEMPLATE];
  const commands: Tree["commands"] = {
    [key("git", "rev-parse", `refs/tags/v${version}^{commit}`)]: HEAD,
    [lsTree(HEAD, true)]: tracked.map((file) => `${file}\0`).join(""),
    [lsTree(HEAD, false)]: tracked
      .map((file) => `100644 blob ${"d".repeat(40)}\t${file}\0`)
      .join(""),
    [key("unzip", "-Z1", "-UU", source)]: [
      ".nvmrc",
      "README.md",
      "apps/",
      "apps/extension/",
      ...Object.keys(files).filter((file) => file !== ".nvmrc"),
    ].join("\n"),
    [catBlob(HEAD, SOURCE_TEMPLATE)]: "Node {{node}}, npm {{npm}}\n",
    [catBlob(HEAD, AMO_SOURCES)]: `${[...Object.keys(files), "README.md"].sort().join("\n")}\n`,
    [unzipEntry(source, "README.md")]: "Node 24.11.0, npm 11.6.2\n",
  };
  for (const [file, content] of Object.entries(files)) {
    commands[unzipEntry(source, file)] = content;
    commands[catBlob(HEAD, file)] = content;
  }
  return commands;
}

type Advisory = { name: string; severity: string; title: string; url: string };
type AuditEntry = Record<string, unknown> & { via: Record<string, unknown>[] };
const CHALK: Advisory = {
  name: "chalk",
  severity: "critical",
  title: "Malware in chalk",
  url: "https://github.com/advisories/GHSA-2v46-p5h4-248w",
};
const UA_PARSER: Advisory = {
  name: "ua-parser-js",
  severity: "high",
  title: "Embedded malware in ua-parser-js",
  url: "https://github.com/advisories/GHSA-pjwm-rvh2-c87w",
};
const NO_COUNTS = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };

/** The entry `npm audit --json` prints for a package that has the advisory itself. */
function auditEntry({ name, severity, title, url }: Advisory): AuditEntry {
  return {
    name,
    severity,
    isDirect: true,
    via: [
      {
        source: 1107375,
        name,
        dependency: name,
        title,
        url,
        severity,
        cwe: ["CWE-506"],
        cvss: { score: 0, vectorString: null },
        range: "=1.0.0",
      },
    ],
    effects: [],
    range: "",
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
}

/** A version 2 report with the given entries and the given tally of vulnerable packages. */
function auditReportOf(
  vulnerabilities: Record<string, unknown>,
  counts: Record<string, unknown>,
): Record<string, unknown> {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { ...counts, total: Object.keys(vulnerabilities).length },
      dependencies: { prod: 4, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 3 },
    },
  };
}

/** The report of a lockfile with one vulnerable package per advisory, as npm prints it. */
function auditReport(...advisories: Advisory[]): Record<string, unknown> {
  const counts: Record<string, number> = { ...NO_COUNTS };
  for (const { severity } of advisories) counts[severity] = (counts[severity] ?? 0) + 1;
  return auditReportOf(
    Object.fromEntries(advisories.map((advisory) => [advisory.name, auditEntry(advisory)])),
    counts,
  );
}

function fakeEnv(tree: Tree): FakeEnv {
  const calls: string[][] = [];
  const relative = (file: string): string => path.relative(ROOT, path.resolve(ROOT, file));
  const reply = (command: string, args: readonly string[]): string | Buffer => {
    calls.push([command, ...args]);
    const answer = tree.commands[key(command, ...args)];
    if (answer === undefined) {
      throw new CommandError([command, ...args].join(" "), 1, "not scripted in the test");
    }
    if (answer instanceof CommandError) throw answer;
    return answer;
  };
  return {
    root: ROOT,
    calls,
    readFile(file) {
      const content = tree.files[relative(file)];
      if (content === undefined) throw new Error(`ENOENT: ${file}`);
      return content;
    },
    exists(file) {
      return tree.files[relative(file)] !== undefined;
    },
    readdir(dir) {
      const prefix = `${relative(dir)}/`;
      const names = Object.keys(tree.files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0] ?? "");
      if (names.length === 0) throw new Error(`ENOENT: ${dir}`);
      return [...new Set(names)];
    },
    sh(command, args) {
      const answer = reply(command, args);
      return typeof answer === "string" ? answer : answer.toString("utf8");
    },
    shBytes(command, args) {
      const answer = reply(command, args);
      return typeof answer === "string" ? Buffer.from(answer) : answer;
    },
    today() {
      return TODAY;
    },
    listTools() {
      if (tree.tools === undefined) throw new Error("no tools scripted in the test");
      return tree.tools;
    },
  };
}

function preRoll(tree: Tree, bump?: Bump): Finding[] {
  const result = checkPreRoll(fakeEnv(tree), bump);
  assert.ok("findings" in result, `unexpected usage result: ${JSON.stringify(result)}`);
  return result.findings;
}

function texts(findings: readonly Finding[], level: Finding["level"]): string[] {
  return findings.filter((finding) => finding.level === level).map((finding) => finding.text);
}

function assertClean(findings: readonly Finding[]): void {
  assert.deepEqual(
    findings.filter((finding) => finding.level !== "INFO"),
    [],
  );
}

function assertFail(findings: readonly Finding[], pattern: RegExp): void {
  const fails = texts(findings, "FAIL");
  assert.ok(
    fails.some((text) => pattern.test(text)),
    `no FAIL matches ${pattern}; FAILs: ${JSON.stringify(fails)}`,
  );
}

function assertOnlyFail(findings: readonly Finding[], pattern: RegExp): void {
  assertFail(findings, pattern);
  assert.equal(texts(findings, "FAIL").length, 1, JSON.stringify(texts(findings, "FAIL")));
}

function shapeProblems(...sectionLines: string[]): string[] {
  return parseChangelog(`${INTRO}\n\n${sectionLines.join("\n")}\n`).problems;
}

describe("parseChangelog", () => {
  test("parses sections, types, entries with continuation lines and bodies", () => {
    const parsed = parseChangelog(changelog(`## [Unreleased]\n\n${ENTRIES}`, OLD_SECTION));
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.preamble, `${INTRO}\n`);
    const [unreleased, released] = parsed.sections;
    assert.equal(unreleased?.header, "## [Unreleased]");
    assert.equal(unreleased?.line, 5);
    assert.equal(unreleased?.version, null);
    assert.deepEqual(unreleased?.types, [
      {
        name: "Added",
        line: 7,
        entries: [
          {
            line: 9,
            text: "The extension opens tabs for your agent, keeping each session's tabs\n  in its own tab group.",
          },
          { line: 11, text: "An MCP server gives your agent the tab tools." },
        ],
      },
    ]);
    assert.equal(unreleased?.body, `\n${ENTRIES}\n`);
    assert.equal(released?.version, "0.1.0");
    assert.equal(released?.date, "2026-10-01");
    assert.equal(released?.body, "\n### Added\n\n- The first release.\n");
  });

  test("accepts an empty Unreleased section, CRLF line ends and any text before it", () => {
    assert.deepEqual(parseChangelog("Some intro\n* a list\n\n## [Unreleased]\n").problems, []);
    const crlf = changelog(`## [Unreleased]\n\n${ENTRIES}`, OLD_SECTION).replaceAll("\n", "\r\n");
    const parsed = parseChangelog(crlf);
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.sections[0]?.types[0]?.entries.length, 2);
  });

  test("continues an entry over blank lines and tab-indented lines", () => {
    const parsed = parseChangelog("## [Unreleased]\n### Fixed\n- one\n\n\ttwo\n");
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.sections[0]?.types[0]?.entries[0]?.text, "one\n\ttwo");
  });

  test("a file without sections fails", () => {
    assert.deepEqual(parseChangelog("# Changelog\n\nNothing yet.\n"), {
      preamble: "# Changelog\n\nNothing yet.\n",
      sections: [],
      problems: ["CHANGELOG.md has no ## [Unreleased] section"],
    });
  });

  const cases: [string, string[], string][] = [
    ["first section not Unreleased", ["## [0.1.0] - 2026-10-01"], "the first section must be"],
    ["a second Unreleased", ["## [Unreleased]", "## [Unreleased]"], "a second ## [Unreleased]"],
    ["a bad header", ["## [Unreleased]", "## 0.1.0 - 2026-10-01"], "a section header must read"],
    ["a leading-zero version", ["## [Unreleased]", "## [01.0.0] - 2026-10-01"], "must read"],
    ["a 30th of February", ["## [Unreleased]", "## [0.1.0] - 2026-02-30"], "not a calendar date"],
    ["a 13th month", ["## [Unreleased]", "## [0.1.0] - 2026-13-01"], "not a calendar date"],
    [
      "versions not descending",
      ["## [Unreleased]", "## [0.1.0] - 2026-10-01", "## [0.2.0] - 2026-10-02"],
      "version 0.2.0 is not below the section above, 0.1.0",
    ],
    [
      "a repeated version",
      ["## [Unreleased]", "## [0.1.0] - 2026-10-01", "## [0.1.0] - 2026-10-01"],
      "is not below",
    ],
    ["an unknown type", ["## [Unreleased]", "### Improved", "- x"], "unknown change type"],
    [
      "a repeated type",
      ["## [Unreleased]", "### Added", "- x", "### Added", "- y"],
      "change type repeated",
    ],
    [
      "types out of order",
      ["## [Unreleased]", "### Fixed", "- x", "### Added", "- y"],
      "change type out of order",
    ],
    ["a loose line", ["## [Unreleased]", "### Added", "- x", "loose"], "not a section header"],
    ["a sub-heading", ["## [Unreleased]", "### Added", "- x", "#### More"], "not a section"],
    ["an entry before a heading", ["## [Unreleased]", "- x"], "an entry before any ###"],
    [
      "a link reference",
      ["## [Unreleased]", "### Added", "- x", "[0.1.0]: https://example.com"],
      "not a section header",
    ],
    [
      "an indented line with no entry",
      ["## [Unreleased]", "### Added", "  x", "- y"],
      "no entry to",
    ],
    ["an indented heading", ["## [Unreleased]", "### Added", "- x", "  ### Removed"], "indented"],
    [
      "a heading with no entries",
      ["## [Unreleased]", "### Added", "", "### Fixed", "- x"],
      "no entries",
    ],
    ["an empty entry", ["## [Unreleased]", "### Added", "- "], "an empty entry"],
    [
      "an indented line after a new heading",
      ["## [Unreleased]", "### Added", "- x", "### Fixed", "  y", "- z"],
      "no entry to",
    ],
    [
      "an indented line after a new section",
      ["## [Unreleased]", "### Added", "- x", "## [0.1.0] - 2026-10-01", "  y"],
      "no entry to",
    ],
    [
      "a dash without a space",
      ["## [Unreleased]", "### Added", "- y", "-x"],
      "not a section header",
    ],
    [
      "a lone carriage return",
      ["## [Unreleased]", "### Fixed", "- Fixed.\r\r### Removed\r\r- Dropped."],
      "a carriage return inside the line",
    ],
  ];
  for (const [name, sectionLines, reason] of cases) {
    test(`fails on ${name}, naming the line`, () => {
      const problems = shapeProblems(...sectionLines);
      assert.equal(problems.length, 1, JSON.stringify(problems));
      const [problem = ""] = problems;
      assert.ok(problem.includes(reason), problem);
      const match = /^CHANGELOG\.md:(\d+): .*: (".*")$/.exec(problem);
      assert.ok(match, problem);
      const lines = `${INTRO}\n\n${sectionLines.join("\n")}`.split("\n");
      assert.equal(JSON.stringify(lines[Number(match[1]) - 1]), match[2]);
    });
  }

  test("fails on a heading, a fence or a lone carriage return above the first section", () => {
    const reason = "a heading or code fence above the first ## section";
    assert.deepEqual(
      shapeProblems(
        "   ## [Unreleased]",
        "### Removed",
        "- Dropped.",
        "    ## an indented code block",
        "##",
        "intro\r## [0.1.0] - 2026-10-01",
        "Release 9.9.9",
        "---",
        " ===  ",
        "```",
        "  ~~~ts",
        "- a list item -",
        "## [Unreleased]",
        "### Fixed",
        "- x",
      ),
      [
        `CHANGELOG.md:5: ${reason}: "   ## [Unreleased]"`,
        `CHANGELOG.md:6: ${reason}: "### Removed"`,
        `CHANGELOG.md:9: ${reason}: "##"`,
        'CHANGELOG.md:10: a carriage return inside the line: "intro\\r## [0.1.0] - 2026-10-01"',
        `CHANGELOG.md:12: ${reason}: "---"`,
        `CHANGELOG.md:13: ${reason}: " ===  "`,
        `CHANGELOG.md:14: ${reason}: "\`\`\`"`,
        `CHANGELOG.md:15: ${reason}: "  ~~~ts"`,
      ],
    );
    assert.deepEqual(parseChangelog("####\r\n").problems, [
      `CHANGELOG.md:1: ${reason}: "####"`,
      "CHANGELOG.md has no ## [Unreleased] section",
    ]);
  });

  test("a continuation line may start with # when it is not a heading", () => {
    assert.deepEqual(
      shapeProblems("## [Unreleased]", "### Fixed", "- Fixes the crash reported in", "  #123."),
      [],
    );
  });

  test("an empty entry is not continued", () => {
    assert.deepEqual(shapeProblems("## [Unreleased]", "### Added", "- x", "- ", "  y"), [
      'CHANGELOG.md:8: an empty entry: "- "',
      'CHANGELOG.md:9: an indented line with no entry to continue: "  y"',
    ]);
  });

  test("an empty heading in the last section fails at end of file", () => {
    assert.deepEqual(shapeProblems("## [Unreleased]", "### Added"), [
      'CHANGELOG.md:6: a change type heading with no entries: "### Added"',
    ]);
  });
});

describe("versions and bumps", () => {
  test("compareVersions compares numerically and with any size", () => {
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
    assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
    assert.equal(compareVersions("0.1.99999999999999999999", "0.1.99999999999999999998"), 1);
    assert.throws(() => compareVersions("01.0.0", "1.0.0"), /not a version/);
  });

  test("nextVersion resets the lower parts", () => {
    assert.equal(nextVersion("0.1.3", "minor"), "0.2.0");
    assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
    assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(nextVersion("0.1.99999999999999999999", "patch"), "0.1.100000000000000000000");
  });

  test("requiredBump follows the change types", () => {
    assert.equal(requiredBump(["Added", "Removed"]), "major");
    assert.equal(requiredBump(["Added"]), "minor");
    assert.equal(requiredBump(["Deprecated", "Fixed"]), "minor");
    assert.equal(requiredBump(["Changed", "Fixed", "Security"]), "patch");
  });

  test("breakingChangeEntries skips negated mentions, also across a wrap", () => {
    const section = parseChangelog(
      [
        "## [Unreleased]",
        "### Changed",
        "- A breaking change to the tools.",
        "- Has no breaking changes.",
        "- This is not a breaking change.",
        "- A non-breaking change.",
        "- A non-",
        "  breaking change, wrapped.",
        "- A Breaking-Change in the",
        "  config, and no breaking change elsewhere.",
        "- A breaking",
        "  change, wrapped.",
        "- Nothing to see.",
      ].join("\n"),
    ).sections[0];
    assert.ok(section);
    assert.deepEqual(breakingChangeEntries(section), [
      { line: 3, text: "A breaking change to the tools." },
      { line: 9, text: "A Breaking-Change in the config, and no breaking change elsewhere." },
      { line: 11, text: "A breaking change, wrapped." },
    ]);
  });
});

describe("pre-roll", () => {
  test("passes the first release and prints its INFO lines", () => {
    const findings = preRoll(firstReleaseTree());
    assertClean(findings);
    assert.deepEqual(texts(findings, "INFO"), [
      `CI run 101 (push) green for ${HEAD.slice(0, 12)}`,
      "npm audit: no advisories",
      "no previous tag: drift check skipped",
      "no previous tag: protocol check against a release skipped",
      "protocol 6, oldest served 3",
      "no previous tag: first release",
      "next version: 0.1.0",
    ]);
  });

  test("refuses --bump on the first release", () => {
    const findings = preRoll(firstReleaseTree(), "minor");
    assertOnlyFail(findings, /^the first release is the current version 0\.1\.0; omit --bump$/);
    assert.ok(texts(findings, "INFO").includes("next version: 0.1.0"));
  });

  test("a missing --bump with a previous tag is a usage error that runs nothing else", () => {
    const env = fakeEnv(secondReleaseTree());
    assert.deepEqual(checkPreRoll(env, undefined), {
      usage: "--bump is required: the previous release is v0.1.0",
    });
    assert.deepEqual(env.calls, [JSON.parse(TAGS)]);
  });

  test("passes the second release with the required bump", () => {
    const findings = preRoll(secondReleaseTree(), "minor");
    assertClean(findings);
    assert.ok(texts(findings, "INFO").includes("previous tag: v0.1.0"));
    assert.ok(texts(findings, "INFO").includes("next version: 0.2.0"));
  });

  const preconditions: [string, (tree: Tree) => void, RegExp][] = [
    ["not on main", (t) => (t.commands[BRANCH] = "feature"), /^on branch "feature", not main$/],
    ["detached", (t) => (t.commands[BRANCH] = "HEAD"), /^HEAD is detached; check out main$/],
    [
      "ahead",
      (t) => Object.assign(t.commands, { [REV_ORIGIN]: OTHER, [COUNTS]: "0\t2" }),
      /^HEAD is 2 commit\(s\) ahead of origin\/main/,
    ],
    [
      "behind",
      (t) => Object.assign(t.commands, { [REV_ORIGIN]: OTHER, [COUNTS]: "3\t0" }),
      /^HEAD is 3 commit\(s\) behind origin\/main; pull first$/,
    ],
    [
      "diverged",
      (t) => Object.assign(t.commands, { [REV_ORIGIN]: OTHER, [COUNTS]: "3\t2" }),
      /^HEAD and origin\/main have diverged: 2 ahead, 3 behind$/,
    ],
    [
      "unequal with no counts",
      (t) => Object.assign(t.commands, { [REV_ORIGIN]: OTHER, [COUNTS]: "0\t0" }),
      /^HEAD a+ is not origin\/main "c+"$/,
    ],
    [
      "dirty",
      (t) => (t.commands[STATUS] = " M src/a.ts\n?? new.txt"),
      /^the working tree is not clean: " M src\/a\.ts", "\?\? new\.txt"$/,
    ],
    [
      "a skip-worktree file",
      (t) => (t.commands[LS_FILES] = "H a\nS hidden.ts"),
      /^"hidden\.ts" is marked skip-worktree/,
    ],
    [
      "an assume-unchanged file",
      (t) => (t.commands[LS_FILES] = "h hidden.ts\nH b"),
      /^"hidden\.ts" is marked assume-unchanged/,
    ],
    [
      "a push URL to another repository",
      (t) => (t.commands[PUSH_URL] = "git@github.com:someone/else.git"),
      /^origin fetches from .* but pushes to "git@github\.com:someone\/else\.git"$/,
    ],
    [
      "two push URLs",
      (t) => (t.commands[PUSH_URL] = `${ORIGIN_URL}\n${ORIGIN_URL}`),
      /^origin must have exactly one push URL/,
    ],
    [
      "an unsupported push URL",
      (t) => (t.commands[PUSH_URL] = "https://gitlab.com/owner/repo.git"),
      /^the origin push URL "https:\/\/gitlab\.com\/owner\/repo\.git" is not a github\.com/,
    ],
    [
      "a bad remote URL",
      (t) => (t.commands[URL] = "https://example.com/owner/repo.git"),
      /^the origin URL "https:\/\/example\.com\/owner\/repo\.git" is not a github\.com repository URL$/,
    ],
    [
      "a remote URL walking up",
      (t) => (t.commands[URL] = "https://github.com/../...git"),
      /^the origin URL .* is not a github\.com/,
    ],
    [
      "an empty Unreleased",
      (t) => (t.files["CHANGELOG.md"] = changelog("## [Unreleased]")),
      /^the Unreleased section of CHANGELOG\.md has no entries$/,
    ],
    [
      "no CI run",
      (t) => (t.commands[GH] = runs()),
      /^no CI run on main for a{12}; start one with gh workflow run ci\.yml --ref main --repo owner\/repo, then gh run watch$/,
    ],
    [
      "a failed run",
      (t) => (t.commands[GH] = runs(ciRun({ conclusion: "failure" }))),
      /^CI run 101 \(push\) for a{12} failed: failure$/,
    ],
    [
      "a running run",
      (t) => (t.commands[GH] = runs(ciRun({ status: "in_progress", conclusion: null }))),
      /^CI run 101 \(push\) for a{12} is still in_progress; wait with gh run watch 101 --exit-status$/,
    ],
    [
      "a cancelled run",
      (t) => (t.commands[GH] = runs(ciRun({ conclusion: "cancelled" }))),
      /^CI run 101 \(push\) for a{12} was cancelled; rerun it with gh run rerun 101, then gh run watch 101 --exit-status$/,
    ],
    [
      "a completed run with no conclusion",
      (t) => (t.commands[GH] = runs(ciRun({ conclusion: null }))),
      /failed: no conclusion$/,
    ],
    [
      "only a gate branch run",
      (t) => (t.commands[GH] = runs(ciRun({ head_branch: "gate/x" }))),
      /^no CI run on main/,
    ],
    [
      "only a run of another workflow file named CI",
      (t) => (t.commands[GH] = runs(ciRun({ path: ".github/workflows/other.yml" }))),
      /^no CI run on main/,
    ],
    [
      "only a run of another workflow name",
      (t) => (t.commands[GH] = runs(ciRun({ name: "Lint" }))),
      /^no CI run on main/,
    ],
    [
      "only a run for another sha",
      (t) => (t.commands[GH] = runs(ciRun({ head_sha: OTHER }))),
      /^no CI run on main/,
    ],
    [
      "only a fork's run from its own main",
      (t) => (t.commands[GH] = runs(ciRun({ head_repository: { full_name: "fork/repo" } }))),
      /^no CI run on main/,
    ],
    [
      "only a run without a head repository",
      (t) => (t.commands[GH] = runs(ciRun({ head_repository: null }))),
      /^no CI run on main/,
    ],
    [
      "a newer failed run after a green one",
      (t) =>
        (t.commands[GH] = runs(
          ciRun(),
          ciRun({ id: 102, conclusion: "failure", run_started_at: "2026-10-18T11:00:00Z" }),
        )),
      /^CI run 102 \(push\) for a{12} failed/,
    ],
    [
      "a failed run with a higher id at the same start",
      (t) => (t.commands[GH] = runs(ciRun(), ciRun({ id: 102, conclusion: "failure" }))),
      /^CI run 102 /,
    ],
    [
      "a matching run with a bad start time",
      (t) => (t.commands[GH] = runs(ciRun({ run_started_at: "soon" }))),
      /^unexpected gh api response: a CI run for a{12} has unexpected fields$/,
    ],
    [
      "a non-array workflow_runs",
      (t) => (t.commands[GH] = JSON.stringify({ workflow_runs: {} })),
      /^unexpected gh api response: workflow_runs is not a list of runs$/,
    ],
    [
      "a malformed HEAD sha",
      (t) => (t.commands[REV_HEAD] = "abc"),
      /^HEAD: git rev-parse HEAD printed "abc"$/,
    ],
    [
      "an invalid v tag",
      (t) => (t.commands[TAGS] = "v1.0"),
      /^the tag "v1\.0" is not a release tag vX\.Y\.Z$/,
    ],
    [
      "the next tag present here",
      (t) => (t.commands[tagList("v0.1.0")] = "v0.1.0"),
      /^the tag v0\.1\.0 already exists here; delete it with git tag -d v0\.1\.0$/,
    ],
    [
      "the next tag on origin",
      (t) => (t.commands[lsRemote("v0.1.0")] = `${TAG_SHA}\trefs/tags/v0.1.0`),
      /^the tag v0\.1\.0 already exists on origin$/,
    ],
  ];
  for (const [name, breakIt, pattern] of preconditions) {
    test(`fails when ${name}`, () => {
      const tree = firstReleaseTree();
      breakIt(tree);
      assertOnlyFail(preRoll(tree), pattern);
    });
  }

  test("a newer green run after a failed one passes", () => {
    const tree = firstReleaseTree();
    tree.commands[GH] = runs(
      ciRun({ id: 102, run_started_at: "2026-10-18T11:00:00Z" }),
      ciRun({ id: 103, conclusion: "failure" }),
    );
    assertClean(preRoll(tree));
  });

  test("accepts a workflow_dispatch run and ignores runs with null fields", () => {
    const tree = firstReleaseTree();
    tree.commands[GH] = runs(
      { id: 7, name: null, head_branch: null, head_sha: HEAD, path: "dynamic/dependabot" },
      ciRun({ id: 8, event: "workflow_dispatch" }),
    );
    const findings = preRoll(tree);
    assertClean(findings);
    assert.ok(
      texts(findings, "INFO").includes(`CI run 8 (workflow_dispatch) green for aaaaaaaaaaaa`),
    );
  });

  test("disagreeing origin URLs skip the CI check", () => {
    const tree = firstReleaseTree();
    tree.commands[PUSH_URL] = "git@github.com:someone/else.git";
    const env = fakeEnv(tree);
    checkPreRoll(env, undefined);
    assert.ok(!env.calls.some(([command]) => command === "gh"));
  });

  test("a tail-matching ls-remote ref does not count as the tag", () => {
    const tree = firstReleaseTree();
    tree.commands[lsRemote("v0.1.0")] = `${TAG_SHA}\trefs/tags/x/refs/tags/v0.1.0`;
    assertClean(preRoll(tree));
  });

  const secondPreconditions: [string, (tree: Tree) => void, RegExp][] = [
    [
      "the latest tag is missing on origin",
      (t) => {
        t.commands[lsRemote("v0.1.0")] = `${TAG_SHA}\trefs/tags/x/refs/tags/v0.1.0`;
        delete t.commands[revTag("v0.1.0")];
      },
      /^the latest tag v0\.1\.0 is not on origin; push it first$/,
    ],
    [
      "the latest tag points elsewhere on origin",
      (t) => (t.commands[lsRemote("v0.1.0")] = `${OTHER}\trefs/tags/v0.1.0`),
      /^the tag v0\.1\.0 is b+ here but c+ on origin$/,
    ],
    [
      "an invalid tag sits next to the latest one",
      (t) => (t.commands[TAGS] = "v0.0.9\nv0.1.0-rc\nv0.1.0"),
      /^the tag "v0\.1\.0-rc" is not a release tag/,
    ],
    [
      "the top section disagrees with the version",
      (t) =>
        (t.files["CHANGELOG.md"] = changelog(
          `## [Unreleased]\n\n${ENTRIES}`,
          OLD_SECTION.replace("0.1.0", "0.0.9"),
        )),
      /^the top released section of CHANGELOG\.md is 0\.0\.9, expected 0\.1\.0 \(the root package\.json version\)$/,
    ],
  ];
  for (const [name, breakIt, pattern] of secondPreconditions) {
    test(`fails when ${name}`, () => {
      const tree = secondReleaseTree();
      breakIt(tree);
      assertOnlyFail(preRoll(tree, "minor"), pattern);
    });
  }

  test("a released section with no tag fails", () => {
    const tree = firstReleaseTree();
    tree.files["CHANGELOG.md"] = changelog(`## [Unreleased]\n\n${ENTRIES}`, OLD_SECTION);
    assertOnlyFail(
      preRoll(tree),
      /^CHANGELOG\.md:13: 0\.1\.0 is released, but no v\* tag is reachable from HEAD$/,
    );
  });

  test("a latest tag behind the version fails", () => {
    const tree = secondReleaseTree();
    Object.assign(tree.commands, {
      [TAGS]: "v0.0.9",
      [lsRemote("v0.0.9")]: `${TAG_SHA}\trefs/tags/v0.0.9`,
      [revTag("v0.0.9")]: TAG_SHA,
      ...driftCommands("v0.0.9"),
      ...protocolCommands("v0.0.9"),
    });
    assertOnlyFail(
      preRoll(tree, "minor"),
      /^the latest tag v0\.0\.9 does not match 0\.1\.0 \(the root package\.json version\)$/,
    );
  });

  test("the latest tag is the highest valid one, whatever git's order", () => {
    const findings: Finding[] = [];
    const tree = firstReleaseTree();
    tree.commands[TAGS] = "v0.9.0\nv0.10.0\nv0.2.0";
    assert.equal(latestTag(fakeEnv(tree), findings), "v0.10.0");
    assert.deepEqual(findings, []);
  });

  test("the next tag is checked here and on origin", () => {
    const tree = secondReleaseTree();
    tree.commands[tagList("v0.2.0")] = "v0.2.0";
    tree.commands[lsRemote("v0.2.0")] = `${OTHER}\trefs/tags/v0.2.0`;
    const fails = texts(preRoll(tree, "minor"), "FAIL");
    assert.deepEqual(fails, [
      "the tag v0.2.0 already exists here; delete it with git tag -d v0.2.0",
      "the tag v0.2.0 already exists on origin",
    ]);
  });

  test("prints every FAIL in one run, including a thrown command error", () => {
    const tree = secondReleaseTree();
    Object.assign(tree.commands, {
      [FETCH]: new CommandError("git fetch", 128, "fatal: unable to access origin\n"),
      [BRANCH]: "feature",
      [STATUS]: " M a.ts",
      [GH]: runs(ciRun({ conclusion: "failure" })),
      [lsRemote("v0.1.0")]: "",
      [tagList("v0.1.1")]: "v0.1.1",
      [lsRemote("v0.1.1")]: "",
    });
    tree.files["apps/server/package.json"] = json({ version: "0.0.1" });
    const fails = texts(preRoll(tree, "patch"), "FAIL");
    assert.deepEqual(fails, [
      "fetch: `git fetch` failed (status 128): fatal: unable to access origin",
      'on branch "feature", not main',
      'the working tree is not clean: " M a.ts"',
      "the latest tag v0.1.0 is not on origin; push it first",
      'apps/server/package.json has version "0.0.1", expected 0.1.0 (the root package.json version)',
      "--bump=patch is smaller than the minor bump the Unreleased changes need",
      "the tag v0.1.1 already exists here; delete it with git tag -d v0.1.1",
      `CI run 101 (push) for ${HEAD.slice(0, 12)} failed: failure`,
    ]);
  });

  test("a shape FAIL skips the checks that read the changelog, and the others still run", () => {
    const tree = secondReleaseTree();
    tree.commands[BRANCH] = "feature";
    tree.files["CHANGELOG.md"] = changelog(`## [Unreleased]\n\n${ENTRIES}`, OLD_SECTION, "stray");
    const findings = preRoll(tree, "patch");
    assert.deepEqual(texts(findings, "FAIL"), [
      'CHANGELOG.md:19: not a section header, change type heading, entry or continuation line: "stray"',
      'on branch "feature", not main',
    ]);
    assert.ok(texts(findings, "INFO").includes("previous tag: v0.1.0"));
  });

  test("a failing tag listing skips the bump and next-tag checks", () => {
    const tree = secondReleaseTree();
    tree.commands[TAGS] = new CommandError("git tag", 128, "fatal: broken");
    const findings = preRoll(tree, "minor");
    assertOnlyFail(findings, /^latest tag: `git tag` failed \(status 128\): fatal: broken$/);
    assert.ok(!texts(findings, "INFO").some((text) => text.startsWith("next version")));
    assert.ok(!texts(findings, "INFO").some((text) => text.includes("previous tag")));
  });
});

describe("bump rules in pre-roll", () => {
  function withUnreleased(body: string, version = "0.1.0"): Tree {
    const tree = secondReleaseTree();
    tree.files["CHANGELOG.md"] = changelog(`## [Unreleased]\n\n${body}`, OLD_SECTION);
    if (version !== "0.1.0") {
      Object.assign(tree.files, packageFiles(version));
      tree.files["CHANGELOG.md"] = changelog(
        `## [Unreleased]\n\n${body}`,
        OLD_SECTION.replace("0.1.0", version),
      );
      const tag = `v${version}`;
      const next = nextVersion(version, "major");
      Object.assign(tree.commands, {
        [TAGS]: tag,
        [lsRemote(tag)]: `${TAG_SHA}\trefs/tags/${tag}`,
        [revTag(tag)]: TAG_SHA,
        [tagList(`v${next}`)]: "",
        [lsRemote(`v${next}`)]: "",
        [tagList(`v${nextVersion(version, "minor")}`)]: "",
        [lsRemote(`v${nextVersion(version, "minor")}`)]: "",
        [tagList(`v${nextVersion(version, "patch")}`)]: "",
        [lsRemote(`v${nextVersion(version, "patch")}`)]: "",
        ...driftCommands(tag),
        ...protocolCommands(tag),
      });
    }
    return tree;
  }

  function scripted(tree: Tree, version: string): Tree {
    for (const bump of ["patch", "minor", "major"] as const) {
      const tag = `v${nextVersion(version, bump)}`;
      tree.commands[tagList(tag)] ??= "";
      tree.commands[lsRemote(tag)] ??= "";
    }
    return tree;
  }

  test("Added needs minor: patch fails, minor passes, major warns", () => {
    const tree = scripted(withUnreleased("### Added\n\n- New."), "0.1.0");
    assertOnlyFail(
      preRoll(tree, "patch"),
      /^--bump=patch is smaller than the minor bump the Unreleased changes need$/,
    );
    assertClean(preRoll(tree, "minor"));
    const findings = preRoll(tree, "major");
    assert.deepEqual(texts(findings, "FAIL"), []);
    assert.deepEqual(texts(findings, "WARNING"), [
      "--bump=major is bigger than the minor bump the Unreleased changes need",
    ]);
    assert.ok(texts(findings, "INFO").includes("next version: 1.0.0"));
  });

  test("Deprecated needs minor, Changed and Fixed need patch", () => {
    const deprecated = scripted(withUnreleased("### Deprecated\n\n- Old."), "0.1.0");
    assertFail(preRoll(deprecated, "patch"), /smaller than the minor bump/);
    const fixed = scripted(withUnreleased("### Changed\n\n- A.\n\n### Fixed\n\n- B."), "0.1.0");
    assertClean(preRoll(fixed, "patch"));
    assert.ok(texts(preRoll(fixed, "patch"), "INFO").includes("next version: 0.1.1"));
    assert.deepEqual(texts(preRoll(fixed, "minor"), "WARNING"), [
      "--bump=minor is bigger than the patch bump the Unreleased changes need",
    ]);
  });

  test("Removed needs major from 1.0.0 on, and minor before, with an INFO", () => {
    const one = scripted(withUnreleased("### Removed\n\n- Gone.", "1.2.0"), "1.2.0");
    assertFail(preRoll(one, "minor"), /^--bump=minor is smaller than the major bump/);
    assertClean(preRoll(one, "major"));
    assert.ok(!texts(preRoll(one, "major"), "INFO").some((text) => text.includes("before 1.0.0")));
    const zero = scripted(withUnreleased("### Removed\n\n- Gone."), "0.1.0");
    const findings = preRoll(zero, "minor");
    assertClean(findings);
    assert.ok(
      texts(findings, "INFO").includes(
        "Removed entries need a major bump, which is minor before 1.0.0; --bump=major releases 1.0.0",
      ),
    );
    assertFail(preRoll(zero, "patch"), /smaller than the minor bump/);
  });

  test("a breaking change warns below major, and below minor while the major is 0", () => {
    const body = "### Fixed\n\n- A breaking change to\n  the config.\n- Not a breaking change.";
    const zero = scripted(withUnreleased(body), "0.1.0");
    const warned = preRoll(zero, "patch");
    assert.deepEqual(texts(warned, "FAIL"), []);
    assert.deepEqual(texts(warned, "WARNING"), [
      'CHANGELOG.md:9: the entry mentions a breaking change but --bump=patch: "A breaking change to the config."',
    ]);
    assert.deepEqual(texts(preRoll(zero, "minor"), "WARNING"), [
      "--bump=minor is bigger than the patch bump the Unreleased changes need",
    ]);
    const one = scripted(withUnreleased(body, "1.0.0"), "1.0.0");
    assert.equal(texts(preRoll(one, "minor"), "WARNING").length, 2);
    assert.equal(
      texts(preRoll(one, "major"), "WARNING").filter((text) => text.includes("breaking")).length,
      0,
    );
  });

  test("a negated breaking change does not warn", () => {
    const tree = scripted(
      withUnreleased("### Fixed\n\n- No breaking changes.\n- A non-\n  breaking change."),
      "0.1.0",
    );
    assertClean(preRoll(tree, "patch"));
  });
});

describe("version sources", () => {
  const sources = [
    "package.json",
    ...WORKSPACES.map((dir) => `${dir}/package.json`),
    "lock",
    'lock ""',
    ...WORKSPACES.map((dir) => `lock ${dir}`),
  ];
  const labels: Record<string, string> = {
    lock: "package-lock.json version",
    'lock ""': 'package-lock.json packages[""].version',
    ...Object.fromEntries(
      WORKSPACES.map((dir) => [`lock ${dir}`, `package-lock.json packages["${dir}"].version`]),
    ),
  };
  for (const source of sources) {
    test(`names ${source} when it disagrees`, () => {
      const tree = firstReleaseTree();
      Object.assign(tree.files, packageFiles("0.1.0", { [source]: "0.1.1" }));
      Object.assign(tree.commands, { [tagList("v0.1.1")]: "", [lsRemote("v0.1.1")]: "" });
      const fails = texts(preRoll(tree), "FAIL");
      if (source === "package.json") {
        assert.equal(fails.length, 10, JSON.stringify(fails));
        assert.ok(
          fails.includes(
            'apps/server/package.json has version "0.1.0", expected 0.1.1 (the root package.json version)',
          ),
        );
      } else {
        assert.deepEqual(fails, [
          `${labels[source] ?? source} has version "0.1.1", expected 0.1.0 (the root package.json version)`,
        ]);
      }
    });
  }

  test("a stale manifest version fails, a matching one passes", () => {
    const tree = firstReleaseTree();
    tree.files[MANIFEST] = json({ ...FIXTURE_MANIFEST, version: "0.0.1" });
    assertOnlyFail(
      preRoll(tree),
      /^apps\/extension\/manifest\.json has version "0\.0\.1", expected 0\.1\.0/,
    );
    tree.files[MANIFEST] = json({ ...FIXTURE_MANIFEST, version: "0.1.0" });
    assertClean(preRoll(tree));
    tree.files[MANIFEST] = json({ ...FIXTURE_MANIFEST, version: 1 });
    assertOnlyFail(preRoll(tree), /^apps\/extension\/manifest\.json has no version string$/);
  });

  test("a missing lockfile workspace entry fails", () => {
    const tree = firstReleaseTree();
    tree.files["package-lock.json"] = json({
      version: "0.1.0",
      packages: { "": { version: "0.1.0" } },
    });
    const fails = texts(preRoll(tree), "FAIL");
    assert.equal(fails.length, 4);
    assert.ok(
      fails.includes('package-lock.json packages["apps/server"].version has no version string'),
    );
  });

  test("a malformed or missing root version fails and is never used", () => {
    const tree = firstReleaseTree();
    tree.files["package.json"] = json({ version: "01.0.0", workspaces: ["apps/*"] });
    const env = fakeEnv(tree);
    const result = checkPreRoll(env, undefined);
    assert.ok("findings" in result);
    assert.deepEqual(texts(result.findings, "FAIL"), [
      'package.json has version "01.0.0", not x.y.z',
    ]);
    assert.ok(!env.calls.some((call) => call.some((arg) => arg.includes("01.0.0"))));
    tree.files["package.json"] = json({ workspaces: ["apps/*"] });
    assert.deepEqual(texts(preRoll(tree), "FAIL"), ["package.json has no version string"]);
  });

  test("unreadable package files fail and the other sources are still checked", () => {
    const tree = firstReleaseTree();
    tree.files["apps/server/package.json"] = "{";
    tree.files["package-lock.json"] = "nope";
    const fails = texts(preRoll(tree), "FAIL");
    assert.equal(fails.length, 2, JSON.stringify(fails));
    assert.match(
      fails[0] ?? "",
      /^apps\/server\/package\.json: apps\/server\/package\.json is not JSON/,
    );
    assert.match(fails[1] ?? "", /^package-lock\.json: package-lock\.json is not JSON/);
    delete tree.files["package.json"];
    assert.deepEqual(texts(preRoll(tree), "FAIL"), ["package.json: ENOENT: package.json"]);
  });

  for (const entry of ["apps/**", "pkg-?", "../x", "/abs", "apps/./x", 7, { glob: "x" }]) {
    test(`refuses the workspaces entry ${JSON.stringify(entry)}`, () => {
      const tree = firstReleaseTree();
      tree.files["package.json"] = json({
        version: "0.1.0",
        workspaces: ["apps/*", "packages/*", entry],
      });
      assertOnlyFail(
        preRoll(tree),
        new RegExp(
          `^unsupported workspaces entry ${escapeRegExp(JSON.stringify(entry))}; use a path or <dir>/\\*$`,
        ),
      );
    });
  }

  test("workspaces must be an array; a glob must match; a literal path needs a package.json", () => {
    const tree = firstReleaseTree();
    tree.files["package.json"] = json({ version: "0.1.0", workspaces: "apps/*" });
    assertFail(preRoll(tree), /^package\.json workspaces is not an array$/);
    tree.files["package.json"] = json({
      version: "0.1.0",
      workspaces: ["apps/*", "packages/*", "apps/server", "docs/*", "tools/x"],
    });
    tree.files["docs/readme.md"] = "x";
    const fails = texts(preRoll(tree), "FAIL");
    assert.deepEqual(fails, [
      "workspaces entry docs/* matches no package",
      "workspaces entry tools/x has no package.json",
    ]);
  });

  test("a literal workspace path is checked", () => {
    const tree = firstReleaseTree();
    tree.files["package.json"] = json({
      version: "0.1.0",
      workspaces: ["apps/*", "packages/protocol"],
    });
    tree.files["package-lock.json"] = json({
      version: "0.1.0",
      packages: Object.fromEntries(
        ["", "apps/extension", "apps/server", "packages/protocol"].map((dir) => [
          dir,
          { version: "0.1.0" },
        ]),
      ),
    });
    assertClean(preRoll(tree));
    tree.files["packages/protocol/package.json"] = json({ version: "0.0.1" });
    assertOnlyFail(preRoll(tree), /^packages\/protocol\/package\.json has version "0\.0\.1"/);
  });
});

describe("listing", () => {
  function listing(tree: Tree): Finding[] {
    return checkListing(fakeEnv(tree));
  }

  function withListing(tree: Tree, edit: (text: string) => string): Tree {
    const before = tree.files[LISTING] ?? "";
    const after = edit(before);
    assert.notEqual(after, before, "the edit changed nothing");
    tree.files[LISTING] = after;
    return tree;
  }

  function withClaims(tree: Tree, claims: unknown): Tree {
    tree.files[CLAIMS] = json(claims);
    return tree;
  }

  function withManifest(tree: Tree, changes: Record<string, unknown>): Tree {
    tree.files[MANIFEST] = json({ ...FIXTURE_MANIFEST, ...changes });
    return tree;
  }

  function claimsCopy(): typeof FIXTURE_CLAIMS {
    return structuredClone(FIXTURE_CLAIMS);
  }

  /** Pads `line` with 🦊, one character but two UTF-16 code units, to a `length`-character body. */
  function padSection(heading: string, line: string, length: number) {
    return (text: string): string => {
      const start = text.indexOf(`${heading}\n`) + heading.length + 1;
      const body = text.slice(start, text.indexOf("\n## ", start)).trim();
      return text.replace(line, `${line} ${"🦊".repeat(length - [...body].length - 1)}`);
    };
  }

  const notJson = /^listing claims: docs\/amo\/listing-claims\.json is not JSON: /;
  const missingCookies =
    'the manifest requests "cookies", but the Permissions section of docs/amo/listing.md has no "- cookies:" bullet';

  test("passes when the listing, the claims, the manifest and the tools agree", () => {
    const findings = listing(firstReleaseTree());
    assert.deepEqual(findings, [{ level: "INFO", text: "no previous tag: drift check skipped" }]);
  });

  test("a registered tool missing from the claims and a claimed tool not registered fail, sorted", () => {
    const tree = firstReleaseTree();
    tree.tools = ["zoom", "navigate", "click"];
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'the server registers the tool "click", which no capability in docs/amo/listing-claims.json lists: add it there, and describe a new capability in docs/amo/listing.md',
      'the server registers the tool "zoom", which no capability in docs/amo/listing-claims.json lists: add it there, and describe a new capability in docs/amo/listing.md',
      'docs/amo/listing-claims.json lists the tool "read_page", which the server does not register: build it, or remove it from the claims file and the capability from docs/amo/listing.md',
      'docs/amo/listing-claims.json lists the tool "tabs_list", which the server does not register: build it, or remove it from the claims file and the capability from docs/amo/listing.md',
    ]);
  });

  test("a tool claimed by two capabilities counts once", () => {
    const claims = claimsCopy();
    claims.capabilities[0]?.tools.push("read_page");
    const tree = withClaims(firstReleaseTree(), claims);
    tree.tools = ["navigate", "tabs_list"];
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing-claims.json lists the tool "read_page", which the server does not register: build it, or remove it from the claims file and the capability from docs/amo/listing.md',
    ]);
  });

  test("a claim string absent from the listing fails, for a capability and a safeguard", () => {
    const claims = claimsCopy();
    const [capability] = claims.capabilities;
    const safeguard = claims.safeguards[2];
    assert.ok(capability && safeguard);
    capability.listing = "open windows";
    safeguard.listing = "acts only on approved tabs";
    assert.deepEqual(texts(listing(withClaims(firstReleaseTree(), claims)), "FAIL"), [
      'docs/amo/listing-claims.json: the capability "open windows" is in no bullet of the list after "The agent can:" in docs/amo/listing.md',
      'docs/amo/listing-claims.json: "acts only on approved tabs" does not occur in docs/amo/listing.md',
      'docs/amo/listing.md line 13 "open tabs and navigate them," has no claim in docs/amo/listing-claims.json',
      'docs/amo/listing.md line 23 "it acts only on tabs in its group." has no claim in docs/amo/listing-claims.json',
    ]);
  });

  test("an uncovered bullet in either list fails with its line number", () => {
    const tree = withListing(firstReleaseTree(), (text) =>
      text
        .replace("- read pages.", "- read pages,\n- take screenshots.")
        .replace("as untrusted.", "as untrusted.\n- Uploads are limited."),
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing.md line 15 "take screenshots." has no claim in docs/amo/listing-claims.json',
      'docs/amo/listing.md line 21 "Uploads are limited." has no claim in docs/amo/listing-claims.json',
    ]);
  });

  test("a claim string that occurs only outside the bullets does not cover a bullet", () => {
    const claims = claimsCopy();
    const [, read] = claims.capabilities;
    assert.ok(read);
    read.listing = "lets an agent use Firefox";
    assert.deepEqual(texts(listing(withClaims(firstReleaseTree(), claims)), "FAIL"), [
      'docs/amo/listing-claims.json: the capability "lets an agent use Firefox" is in no bullet of the list after "The agent can:" in docs/amo/listing.md',
      'docs/amo/listing.md line 14 "read pages." has no claim in docs/amo/listing-claims.json',
    ]);
  });

  test("a capability claim counts only in the capability list", () => {
    const tree = withListing(firstReleaseTree(), (text) =>
      text.replace("- read pages.\n", "").replace("Linux only;", "It can read pages. Linux only;"),
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing-claims.json: the capability "read pages" is in no bullet of the list after "The agent can:" in docs/amo/listing.md',
    ]);
  });

  test("a bullet needs a claim from its own list", () => {
    const tree = withListing(firstReleaseTree(), (text) =>
      text
        .replace("- read pages.", "- read pages,\n- acts only on tabs in its group.")
        .replace("as untrusted.", "as untrusted.\n- It can read pages only in approved tabs."),
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing.md line 15 "acts only on tabs in its group." has no claim in docs/amo/listing-claims.json',
      'docs/amo/listing.md line 21 "It can read pages only in approved tabs." has no claim in docs/amo/listing-claims.json',
    ]);
  });

  test("a bullet of the first-screen protections needs a safeguard claim", () => {
    const tree = withListing(firstReleaseTree(), (text) =>
      text.replace(
        "- it acts only on tabs in its group.",
        "- it acts only on tabs in its group,\n- it can read pages only on approved sites.",
      ),
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing.md line 24 "it can read pages only on approved sites." has no claim in docs/amo/listing-claims.json',
    ]);
  });

  test("a list item with another marker needs its own claim", () => {
    const tree = withListing(firstReleaseTree(), (text) =>
      text.replace("as untrusted.", "as untrusted.\n* It can run code from any page."),
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing.md line 20 "It can run code from any page." has no claim in docs/amo/listing-claims.json',
    ]);
  });

  test("a claim may span a wrapped line", () => {
    const tree = withListing(firstReleaseTree(), (text) =>
      text.replace("mark page content as", "mark page content\n  as"),
    );
    assertClean(listing(tree));
  });

  test("a wrapped bullet does not end the list", () => {
    const tree = withListing(firstReleaseTree(), (text) =>
      text.replace(
        "- read pages.",
        "- read pages,\n  including hidden fields,\n- run code from the page.",
      ),
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing.md line 16 "run code from the page." has no claim in docs/amo/listing-claims.json',
    ]);
  });

  test("listingBullets reads both lists of a listing in the real layout", () => {
    const text = [
      "# AMO listing",
      "",
      "The agent can: not at the end of this line.",
      "The agent can:",
      "",
      "- open tabs and navigate them,",
      "- read pages,",
      "  ",
      "- click, type and fill in forms,",
      "- take screenshots,",
      "- read the console and network activity,",
      "- upload files from allowed folders.",
      "",
      "Not a bullet, so the list ends here.",
      "- not in the list",
      "",
      "A long paragraph that ends with the intro. Foxleash limits what a fooled agent can do:",
      "",
      "- One.",
      "- Two.",
      "",
      "- Three.",
      "- Four.",
      "",
      "## Permissions",
      "",
      "- tabs: not in the list either.",
    ].join("\r\n");
    const capabilities = listingBullets(text, "The agent can:");
    assert.deepEqual(capabilities, [
      { line: 6, text: "open tabs and navigate them," },
      { line: 7, text: "read pages," },
      { line: 9, text: "click, type and fill in forms," },
      { line: 10, text: "take screenshots," },
      { line: 11, text: "read the console and network activity," },
      { line: 12, text: "upload files from allowed folders." },
    ]);
    const safeguards = listingBullets(text, "Foxleash limits what a fooled agent can do:");
    assert.deepEqual(
      Array.isArray(safeguards) && safeguards.map((bullet) => [bullet.line, bullet.text]),
      [
        [19, "One."],
        [20, "Two."],
        [22, "Three."],
        [23, "Four."],
      ],
    );
  });

  test("listingBullets joins the lines of a wrapped bullet, as Markdown does", () => {
    const text = [
      "The agent can:",
      "",
      "- read pages,",
      "  including hidden fields,",
      "",
      "  and frames,",
      "- click, type",
      "and fill in forms,",
      "- take screenshots.",
      "## Permissions",
      "- tabs: not in the list.",
    ].join("\n");
    assert.deepEqual(listingBullets(text, "The agent can:"), [
      { line: 3, text: "read pages, including hidden fields, and frames," },
      { line: 7, text: "click, type and fill in forms," },
      { line: 9, text: "take screenshots." },
    ]);
  });

  test("listingBullets ends a list only where Markdown does", () => {
    const text = [
      "The agent can:",
      "",
      "- read pages,",
      "#1 priority, and",
      "####### no heading either,",
      "\u00a0",
      "- click,",
      "\t",
      "\tand type,",
      "- scroll.",
      "#",
      "- not in the list",
    ].join("\n");
    assert.deepEqual(listingBullets(text, "The agent can:"), [
      { line: 3, text: "read pages, #1 priority, and ####### no heading either, " },
      { line: 7, text: "click, and type," },
      { line: 10, text: "scroll." },
    ]);
  });

  test("listingBullets takes every kind of list item as its own bullet", () => {
    const text = [
      "The agent can:",
      "",
      "- open tabs,",
      "* run code,",
      "+ read pages,",
      "1. click,",
      "10) type,",
      "-\tscroll,",
      " - hover,",
      "  - drag,",
      "-x and **bold** continue it,",
      "-",
    ].join("\n");
    assert.deepEqual(listingBullets(text, "The agent can:"), [
      { line: 3, text: "open tabs," },
      { line: 4, text: "run code," },
      { line: 5, text: "read pages," },
      { line: 6, text: "click," },
      { line: 7, text: "type," },
      { line: 8, text: "scroll," },
      { line: 9, text: "hover," },
      { line: 10, text: "drag, -x and **bold** continue it," },
      { line: 12, text: "" },
    ]);
  });

  test("listingBullets reports a missing intro and an intro with no list", () => {
    assert.equal(
      listingBullets("The agent can do this:\n- a", "The agent can:"),
      'docs/amo/listing.md has no line ending with "The agent can:"',
    );
    assert.equal(
      listingBullets("The agent can:\n\nNothing.\n- a", "The agent can:"),
      'docs/amo/listing.md: no bullet list follows "The agent can:"',
    );
    assert.equal(
      listingBullets("The agent can:\n", "The agent can:"),
      'docs/amo/listing.md: no bullet list follows "The agent can:"',
    );
  });

  test("a missing intro and an intro with no bullets fail in the check", () => {
    const missing = withListing(firstReleaseTree(), (text) =>
      text.replace("The agent can:", "The agent:"),
    );
    assert.deepEqual(texts(listing(missing), "FAIL"), [
      'docs/amo/listing.md has no line ending with "The agent can:"',
    ]);
    const empty = withListing(firstReleaseTree(), (text) =>
      text.replace(
        "- open tabs and navigate them,\n- read pages.",
        "It can open tabs and navigate them, and read pages.",
      ),
    );
    assert.deepEqual(texts(listing(empty), "FAIL"), [
      'docs/amo/listing.md: no bullet list follows "The agent can:"',
    ]);
  });

  test("a missing protections intro and one with no bullets fail in the check", () => {
    const missing = withListing(firstReleaseTree(), (text) =>
      text.replace("What protects you:", "What protects:"),
    );
    assert.deepEqual(texts(listing(missing), "FAIL"), [
      'docs/amo/listing.md has no line ending with "What protects you:"',
    ]);
    const empty = withListing(firstReleaseTree(), (text) =>
      text.replace("- it acts only on tabs in its group.", "It acts only on tabs in its group."),
    );
    assert.deepEqual(texts(listing(empty), "FAIL"), [
      'docs/amo/listing.md: no bullet list follows "What protects you:"',
    ]);
  });

  test("a claims file that is not JSON fails, and the permission checks still run", () => {
    const tree = withManifest(firstReleaseTree(), { permissions: ["tabs", "storage", "cookies"] });
    tree.files[CLAIMS] = "{";
    const fails = texts(listing(tree), "FAIL");
    assert.equal(fails.length, 2, JSON.stringify(fails));
    assert.match(fails[0] ?? "", notJson);
    assert.equal(fails[1], missingCookies);
  });

  test("with bad claims, the intros, the tools and the permissions are still checked", () => {
    const tree = withListing(
      withManifest(withClaims(firstReleaseTree(), { note: "x" }), {
        permissions: ["tabs", "storage", "cookies"],
      }),
      (text) => text.replace("The agent can:", "The agent:"),
    );
    delete tree.tools;
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing-claims.json: the top level has no "capabilities"',
      'docs/amo/listing-claims.json: the top level has no "safeguards"',
      "registered tools: no tools scripted in the test",
      'docs/amo/listing.md has no line ending with "The agent can:"',
      missingCookies,
    ]);
  });

  test("every shape problem of the claims file is its own FAIL, and nothing is read", () => {
    const tree = withManifest(
      withClaims(firstReleaseTree(), {
        note: 7,
        capabilities: [
          { listing: "", tools: [] },
          { listing: "read pages", tools: ["read_page", ""] },
          "open tabs",
          { listing: "x", tools: ["x"], extra: true },
          { listing: " ", tools: ["x"] },
        ],
        safeguards: [
          { listing: "The approval can only come from your click", evidence: "none" },
          {
            listing: 3,
            evidence: [
              { file: "apps/extension/src/tools.ts", contain: "untrusted" },
              { file: "/etc/passwd", contains: "root" },
              { file: "src/../../secret", contains: "x" },
              { file: "apps/extension/src/tools.ts", contains: "a", lacks: "b" },
              { file: "", lacks: 5 },
              null,
            ],
          },
          { evidence: [] },
        ],
      }),
      { permissions: ["tabs", "storage", "cookies"] },
    );
    const env = fakeEnv(tree);
    assert.deepEqual(texts(checkListing(env), "FAIL"), [
      "docs/amo/listing-claims.json: note must be a string",
      "docs/amo/listing-claims.json: capabilities[0].listing must be a non-empty string",
      "docs/amo/listing-claims.json: capabilities[0].tools must be a non-empty array of non-empty strings",
      "docs/amo/listing-claims.json: capabilities[1].tools must be a non-empty array of non-empty strings",
      'docs/amo/listing-claims.json: capabilities[2] must be an object with "listing", "tools"',
      'docs/amo/listing-claims.json: capabilities[3] has the unknown key "extra"',
      "docs/amo/listing-claims.json: capabilities[4].listing must be a non-empty string",
      "docs/amo/listing-claims.json: safeguards[0].evidence must be an array",
      "docs/amo/listing-claims.json: safeguards[1].listing must be a non-empty string",
      'docs/amo/listing-claims.json: safeguards[1].evidence[0] has the unknown key "contain"',
      'docs/amo/listing-claims.json: safeguards[1].evidence[0] needs a string "file" and exactly one of "contains" or "lacks"',
      "docs/amo/listing-claims.json: safeguards[1].evidence[1].file must be a relative path inside the checkout",
      "docs/amo/listing-claims.json: safeguards[1].evidence[2].file must be a relative path inside the checkout",
      'docs/amo/listing-claims.json: safeguards[1].evidence[3] needs a string "file" and exactly one of "contains" or "lacks"',
      "docs/amo/listing-claims.json: safeguards[1].evidence[4].file must be a non-empty string",
      "docs/amo/listing-claims.json: safeguards[1].evidence[4].lacks must be a non-empty string",
      'docs/amo/listing-claims.json: safeguards[1].evidence[5] needs a string "file" and exactly one of "contains" or "lacks"',
      'docs/amo/listing-claims.json: safeguards[2] has no "listing"',
      missingCookies,
    ]);
    assert.ok(!env.calls.some(([command, verb]) => command === "git" && verb === "ls-files"));
  });

  test("a claims file of the wrong top-level shape fails", () => {
    for (const [claims, problem] of [
      [[], 'the top level must be an object with "note", "capabilities", "safeguards"'],
      [
        { note: "x", capabilities: {}, safeguards: [], notes: "" },
        'the top level has the unknown key "notes"',
      ],
    ] as const) {
      assert.deepEqual(texts(listing(withClaims(firstReleaseTree(), claims)), "FAIL"), [
        `docs/amo/listing-claims.json: ${problem}`,
      ]);
    }
    assert.deepEqual(
      texts(
        listing(withClaims(firstReleaseTree(), { note: "x", capabilities: {}, safeguards: [] })),
        "FAIL",
      ),
      ["docs/amo/listing-claims.json: capabilities must be an array"],
    );
  });

  test("a capability with no tools fails, and the permission checks still run", () => {
    const claims = claimsCopy();
    const [open] = claims.capabilities;
    assert.ok(open);
    open.tools = [];
    const tree = withManifest(withClaims(firstReleaseTree(), claims), {
      permissions: ["tabs", "storage", "cookies"],
    });
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      "docs/amo/listing-claims.json: capabilities[0].tools must be a non-empty array of non-empty strings",
      missingCookies,
    ]);
  });

  test("safeguard evidence: empty, a missing string, a present string, an untracked file", () => {
    const claims = {
      ...claimsCopy(),
      safeguards: [
        { listing: "The approval can only come from your click", evidence: [] },
        {
          listing: "Tool results mark page content as untrusted",
          evidence: [
            { file: "apps/extension/src/tools.ts", contains: "trusted data" },
            { file: "apps/extension/src/tools.ts", lacks: "session's group" },
            { file: "src/new.ts", contains: "x" },
            { file: "src/link.ts", contains: "x" },
            { file: "src/gone.ts", contains: "x" },
            { file: "src/other.ts", contains: "x" },
            { file: "src/conflict.ts", contains: "x" },
            { file: "apps/extension/src/approval.ts", lacks: "eval" },
          ],
        },
        {
          listing: "acts only on tabs in its group",
          evidence: [{ file: "apps/extension/src/tools.ts", contains: "group" }],
        },
      ],
    };
    const tree = withClaims(firstReleaseTree(), claims);
    Object.assign(tree.files, {
      "src/new.ts": "x",
      "src/link.ts": "x",
      "src/other.ts": "x",
      "src/conflict.ts": "x",
    });
    Object.assign(tree.commands, {
      [lsStaged("src/new.ts")]: "",
      [lsStaged("src/link.ts")]: stagedEntry("src/link.ts", "120000"),
      [lsStaged("src/gone.ts")]: stagedEntry("src/gone.ts"),
      [lsStaged("src/other.ts")]: `${stagedEntry("src/other.ts/x")}${stagedEntry("src/other.tsx")}`,
      [lsStaged("src/conflict.ts")]: `100644 ${"d".repeat(40)} 2\tsrc/conflict.ts\0`,
    });
    const name = 'safeguard "Tool results mark page content as untrusted"';
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'safeguard "The approval can only come from your click" has no evidence in the build yet',
      `${name}: apps/extension/src/tools.ts does not contain "trusted data"`,
      `${name}: apps/extension/src/tools.ts contains "session's group", which it must not`,
      `${name}: src/new.ts is not a tracked regular file`,
      `${name}: src/link.ts is not a tracked regular file`,
      `${name}: src/gone.ts is not a tracked regular file`,
      `${name}: src/other.ts is not a tracked regular file`,
      `${name}: src/conflict.ts is not a tracked regular file`,
    ]);
  });

  test("a tracked executable file and a SHA-256 entry count as evidence", () => {
    const tree = firstReleaseTree();
    tree.commands[lsStaged("apps/extension/src/approval.ts")] =
      `100755 ${"e".repeat(64)} 0\tapps/extension/src/approval.ts\0`;
    tree.commands[lsStaged("apps/extension/src/tools.ts")] =
      `100644 ${"e".repeat(64)} 0\tapps/extension/src/tools.ts\0`;
    assertClean(listing(tree));
  });

  test("a failing git ls-files is a FAIL naming the safeguard", () => {
    const tree = firstReleaseTree();
    tree.commands[lsStaged("apps/extension/src/approval.ts")] = new CommandError(
      "git ls-files",
      128,
      "fatal: x",
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'safeguard "The approval can only come from your click": `git ls-files` failed (status 128): fatal: x',
    ]);
  });

  test("every manifest permission and category needs its explanation, and the reverse", () => {
    const tree = withManifest(firstReleaseTree(), {
      permissions: ["tabs", "cookies"],
      host_permissions: ["<all_urls>", "https://*.example.com/*"],
      optional_permissions: ["downloads"],
      browser_specific_settings: {
        gecko: {
          data_collection_permissions: {
            required: ["websiteContent", "locationInfo"],
            optional: ["browsingActivity", "authenticationInfo"],
          },
        },
      },
    });
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      missingCookies,
      'the manifest requests "https://*.example.com/*", but the Permissions section of docs/amo/listing.md has no "- https://*.example.com/*:" bullet',
      'the manifest requests "downloads", but the Permissions section of docs/amo/listing.md has no "- downloads:" bullet',
      'docs/amo/listing.md line 30 explains the permission "storage", which the manifest does not request',
      'the manifest declares the data collection category "locationInfo", but the Data collection and handling section of docs/amo/listing.md does not name it as "(locationInfo)"',
      'the manifest declares the data collection category "authenticationInfo", but the Data collection and handling section of docs/amo/listing.md does not name it as "(authenticationInfo)"',
    ]);
  });

  test("an optional host permission needs its bullet, and a URL pattern can have one", () => {
    const tree = withManifest(firstReleaseTree(), {
      optional_host_permissions: ["https://*.example.com/*"],
    });
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'the manifest requests "https://*.example.com/*", but the Permissions section of docs/amo/listing.md has no "- https://*.example.com/*:" bullet',
    ]);
    withListing(tree, (text) =>
      text.replace("- storage:", "- https://*.example.com/*: the example site.\n- storage:"),
    );
    assertClean(listing(tree));
  });

  test("a permission bullet is a name, a colon and a space or the line end", () => {
    const tree = withListing(
      withManifest(firstReleaseTree(), { permissions: ["tabs", "storage", "cookies"] }),
      (text) => text.replace("- storage:", "- cookies:\n- storage:"),
    );
    assertClean(listing(tree));
    withListing(tree, (text) => text.replace("- cookies:\n", "- cookies:x\n"));
    assert.deepEqual(texts(listing(tree), "FAIL"), [missingCookies]);
  });

  test("the Permissions section, each version's notes to reviewers, holds at most 3000 characters", () => {
    const body = (text: string) =>
      text.slice(text.indexOf("Why Foxleash"), text.indexOf("\n\n## Data collection and handling"));
    const last = "- <all_urls>: works on any approved site.";
    // One character, two UTF-16 code units.
    const padded = (length: number) => (text: string) =>
      text.replace(last, `${last} ${"🦊".repeat(length - [...body(text)].length - 1)}`);
    assertClean(listing(withListing(firstReleaseTree(), padded(3000))));
    assert.deepEqual(texts(listing(withListing(firstReleaseTree(), padded(3001))), "FAIL"), [
      "the Permissions section of docs/amo/listing.md is 3001 characters, but AMO takes at most 3000 as a version's notes to reviewers: shorten it",
    ]);
  });

  test("the Summary, the add-on's summary, holds at most 250 characters", () => {
    const padded = (length: number) =>
      padSection("## Summary", "Lets an agent use Firefox.", length);
    assertClean(listing(withListing(firstReleaseTree(), padded(250))));
    assert.deepEqual(texts(listing(withListing(firstReleaseTree(), padded(251))), "FAIL"), [
      "the Summary section of docs/amo/listing.md is 251 characters, but AMO takes at most 250 as the add-on's summary: shorten it",
    ]);
  });

  test("the Description, the add-on's description, holds at most 15000 characters", () => {
    const padded = (length: number) =>
      padSection("## Description", "Foxleash lets an agent use Firefox.", length);
    assertClean(listing(withListing(firstReleaseTree(), padded(15000))));
    assert.deepEqual(texts(listing(withListing(firstReleaseTree(), padded(15001))), "FAIL"), [
      "the Description section of docs/amo/listing.md is 15001 characters, but AMO takes at most 15000 as the add-on's description: shorten it",
    ]);
  });

  test("a listing without a Summary or a Description section fails", () => {
    for (const heading of ["## Summary", "## Description"]) {
      const tree = withListing(firstReleaseTree(), (text) =>
        text.replace(`${heading}\n`, `${heading} here\n`),
      );
      assert.deepEqual(texts(listing(tree), "FAIL"), [
        `docs/amo/listing.md has no "${heading}" section`,
      ]);
    }
  });

  test("a bullet outside the Permissions section explains no permission", () => {
    const tree = withListing(
      withManifest(firstReleaseTree(), { permissions: ["tabs", "storage", "cookies"] }),
      (text) => text.replace("Linux only;", "- cookies: not here.\n\nLinux only;"),
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [missingCookies]);
  });

  test("a manifest value of the wrong shape fails and is not used", () => {
    const tree = withManifest(firstReleaseTree(), {
      permissions: "tabs",
      host_permissions: ["<all_urls>", 7],
      browser_specific_settings: {
        gecko: { data_collection_permissions: { required: "websiteContent", optional: [null] } },
      },
    });
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      "apps/extension/manifest.json: permissions must be absent or an array of strings",
      "apps/extension/manifest.json: host_permissions must be absent or an array of strings",
      "apps/extension/manifest.json: browser_specific_settings.gecko.data_collection_permissions.required must be absent or an array of strings",
      "apps/extension/manifest.json: browser_specific_settings.gecko.data_collection_permissions.optional must be absent or an array of strings",
      'docs/amo/listing.md line 29 explains the permission "tabs", which the manifest does not request',
      'docs/amo/listing.md line 30 explains the permission "storage", which the manifest does not request',
      'docs/amo/listing.md line 31 explains the permission "<all_urls>", which the manifest does not request',
    ]);
  });

  test("a missing section heading fails; a heading must be the whole line", () => {
    const tree = withListing(
      withManifest(firstReleaseTree(), { permissions: ["tabs", "storage", "cookies"] }),
      (text) =>
        text
          .replace("## Permissions\n", "## Permissions here\n")
          .replace("## Data collection and handling\n", "## Data collection and handling.\n"),
    );
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      'docs/amo/listing.md has no "## Permissions" section',
      'docs/amo/listing.md has no "## Data collection and handling" section',
    ]);
  });

  test("a listing with CRLF line endings passes", () => {
    const tree = withListing(firstReleaseTree(), (text) => text.replaceAll("\n", "\r\n"));
    assertClean(listing(tree));
  });

  test("a missing listing is one FAIL, and the tools are still compared", () => {
    const tree = firstReleaseTree();
    delete tree.files[LISTING];
    tree.tools = [...FIXTURE_TOOLS, "click"];
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      "listing text: ENOENT: docs/amo/listing.md",
      'the server registers the tool "click", which no capability in docs/amo/listing-claims.json lists: add it there, and describe a new capability in docs/amo/listing.md',
    ]);
  });

  test("a failing tool list is a FAIL, and the other checks still run", () => {
    const claims = claimsCopy();
    const [open, read] = claims.capabilities;
    const [approval] = claims.safeguards;
    assert.ok(open && read && approval);
    open.listing = "open every tab";
    approval.evidence = [];
    const tree = withListing(
      withManifest(withClaims(firstReleaseTree(), claims), {
        permissions: ["tabs", "storage", "cookies"],
      }),
      (text) => text.replace("- read pages.", "- read pages,\n- take screenshots."),
    );
    delete tree.tools;
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      "registered tools: no tools scripted in the test",
      'docs/amo/listing-claims.json: the capability "open every tab" is in no bullet of the list after "The agent can:" in docs/amo/listing.md',
      'docs/amo/listing.md line 13 "open tabs and navigate them," has no claim in docs/amo/listing-claims.json',
      'docs/amo/listing.md line 15 "take screenshots." has no claim in docs/amo/listing-claims.json',
      'safeguard "The approval can only come from your click" has no evidence in the build yet',
      missingCookies,
    ]);
  });

  test("a missing manifest is a FAIL and skips the permission checks", () => {
    const tree = firstReleaseTree();
    delete tree.files[MANIFEST];
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      "listing manifest: ENOENT: apps/extension/manifest.json",
      'safeguard "Tool results mark page content as untrusted": apps/extension/manifest.json is not a tracked regular file',
    ]);
  });

  test("a failing tag listing is one FAIL and skips the drift check", () => {
    const tree = firstReleaseTree();
    tree.commands[TAGS] = new CommandError("git tag", 128, "fatal: broken");
    const findings = listing(tree);
    assert.deepEqual(findings, [
      { level: "FAIL", text: "latest tag: `git tag` failed (status 128): fatal: broken" },
    ]);
  });

  test("with a tag, the three diffs print and an unchanged manifest passes", () => {
    const tree = firstReleaseTree();
    Object.assign(tree.commands, { [TAGS]: "v0.1.0", ...driftCommands("v0.1.0") });
    tree.commands[diffSince("v0.1.0", AMO_SOURCES)] = "+src/a.js\n-src/b.js";
    assert.deepEqual(listing(tree), [
      { level: "INFO", text: "manifest since v0.1.0: no change" },
      { level: "INFO", text: "listing since v0.1.0: no change" },
      { level: "INFO", text: "AMO source files since v0.1.0:" },
      { level: "INFO", text: "+src/a.js" },
      { level: "INFO", text: "-src/b.js" },
    ]);
  });

  test("names every changed declaration, in order, when the listing did not change", () => {
    const tree = withManifest(firstReleaseTree(), {
      optional_permissions: ["tabs"],
      optional_host_permissions: ["<all_urls>"],
      content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }],
    });
    Object.assign(tree.commands, {
      [TAGS]: "v0.1.0",
      ...driftCommands("v0.1.0"),
      [show("refs/tags/v0.1.0", MANIFEST)]: json({ manifest_version: 3 }),
    });
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      "the manifest's permissions, host_permissions, optional_permissions, optional_host_permissions, content_scripts matches, data_collection_permissions changed since v0.1.0, but docs/amo/listing.md did not: update the listing to match",
    ]);
    tree.commands[diffSince("v0.1.0", LISTING)] = "+a line";
    assertClean(listing(tree));
  });

  test("a type change of a declaration counts as a change", () => {
    const tree = firstReleaseTree();
    Object.assign(tree.commands, {
      [TAGS]: "v0.1.0",
      ...driftCommands("v0.1.0"),
      [show("refs/tags/v0.1.0", MANIFEST)]: json({
        ...FIXTURE_MANIFEST,
        content_scripts: "none",
        browser_specific_settings: { gecko: { data_collection_permissions: [] } },
      }),
    });
    assert.deepEqual(texts(listing(tree), "FAIL"), [
      "the manifest's content_scripts matches, data_collection_permissions changed since v0.1.0, but docs/amo/listing.md did not: update the listing to match",
    ]);
  });

  test("a failing git show is its own FAIL, and the three diffs still print", () => {
    const tree = firstReleaseTree();
    Object.assign(tree.commands, { [TAGS]: "v0.1.0", ...driftCommands("v0.1.0") });
    tree.commands[show("refs/tags/v0.1.0", MANIFEST)] = new CommandError(
      "git show",
      128,
      "fatal: no",
    );
    const findings = listing(tree);
    assert.deepEqual(texts(findings, "FAIL"), [
      "apps/extension/manifest.json at v0.1.0: `git show` failed (status 128): fatal: no",
    ]);
    assert.deepEqual(texts(findings, "INFO"), [
      "manifest since v0.1.0: no change",
      "listing since v0.1.0: no change",
      "AMO source files since v0.1.0: no change",
    ]);
  });

  test("a failing git diff is its own FAIL and skips only the comparison that needs it", () => {
    const tree = withManifest(firstReleaseTree(), { optional_permissions: ["tabs"] });
    Object.assign(tree.commands, { [TAGS]: "v0.1.0", ...driftCommands("v0.1.0") });
    tree.commands[diffSince("v0.1.0", LISTING)] = new CommandError("git diff", 128, "fatal: no");
    const findings = listing(tree);
    assert.deepEqual(texts(findings, "FAIL"), [
      "docs/amo/listing.md since v0.1.0: `git diff` failed (status 128): fatal: no",
    ]);
    assert.deepEqual(texts(findings, "INFO"), [
      "manifest since v0.1.0: no change",
      "AMO source files since v0.1.0: no change",
    ]);
  });

  test("an unreadable manifest skips the drift comparison, and the diffs still print", () => {
    const tree = firstReleaseTree();
    tree.files[MANIFEST] = "{";
    Object.assign(tree.commands, { [TAGS]: "v0.1.0", ...driftCommands("v0.1.0") });
    const findings = listing(tree);
    const fails = texts(findings, "FAIL");
    assert.equal(fails.length, 1, JSON.stringify(fails));
    assert.match(fails[0] ?? "", /^listing manifest: apps\/extension\/manifest\.json is not JSON/);
    assert.equal(texts(findings, "INFO").length, 3);
  });

  test("pre-roll runs the listing checks and keeps every other check", () => {
    const tree = secondReleaseTree();
    tree.commands[BRANCH] = "feature";
    tree.tools = [...FIXTURE_TOOLS, "click"];
    const findings = preRoll(tree, "minor");
    assert.deepEqual(texts(findings, "FAIL"), [
      'on branch "feature", not main',
      'the server registers the tool "click", which no capability in docs/amo/listing-claims.json lists: add it there, and describe a new capability in docs/amo/listing.md',
    ]);
    assert.deepEqual(texts(findings, "INFO"), [
      `CI run 101 (push) green for ${HEAD.slice(0, 12)}`,
      "npm audit: no advisories",
      "manifest since v0.1.0: no change",
      "listing since v0.1.0: no change",
      "AMO source files since v0.1.0: no change",
      "protocol 6, oldest served 3, v0.1.0 has 3",
      "previous tag: v0.1.0",
      "next version: 0.2.0",
    ]);
  });

  test("pre-roll with a failing tag listing runs the listing checks without the drift part", () => {
    const tree = secondReleaseTree();
    tree.commands[TAGS] = new CommandError("git tag", 128, "fatal: broken");
    tree.tools = [...FIXTURE_TOOLS, "click"];
    const findings = preRoll(tree, "minor");
    assert.equal(texts(findings, "FAIL").length, 2, JSON.stringify(texts(findings, "FAIL")));
    assertFail(findings, /^the server registers the tool "click"/);
    assert.deepEqual(texts(findings, "INFO"), [
      `CI run 101 (push) green for ${HEAD.slice(0, 12)}`,
      "npm audit: no advisories",
      "protocol 6, oldest served 3",
    ]);
  });
});

describe("protocol", () => {
  const TAGGED = "v0.4.1";
  const missing = (name: string): string =>
    `no line "export const ${name} = <number>;" in ${PROTOCOL}`;

  /** The numbers in the working tree, and what the latest tag, v0.4.1, shipped (none: no tag). */
  function protocolTree(current: number, oldest: number | undefined, tagged?: number): Tree {
    const tree: Tree = { files: { [PROTOCOL]: protocolSource(current, oldest) }, commands: {} };
    tree.commands[TAGS] = tagged === undefined ? "" : TAGGED;
    if (tagged !== undefined) {
      tree.commands[show(`refs/tags/${TAGGED}`, PROTOCOL)] = protocolSource(tagged);
    }
    return tree;
  }

  function protocol(tree: Tree): Finding[] {
    return checkProtocol(fakeEnv(tree));
  }

  test("passes with a tag and prints the three numbers", () => {
    assert.deepEqual(protocol(protocolTree(6, 3, 3)), [
      { level: "INFO", text: "protocol 6, oldest served 3, v0.4.1 has 3" },
    ]);
  });

  test("passes without a tag and says there is no previous tag", () => {
    assert.deepEqual(protocol(protocolTree(6, 3)), [
      { level: "INFO", text: "no previous tag: protocol check against a release skipped" },
      { level: "INFO", text: "protocol 6, oldest served 3" },
    ]);
  });

  test("passes when the numbers meet at a boundary", () => {
    assert.deepEqual(texts(protocol(protocolTree(6, 5, 5)), "FAIL"), []);
    assert.deepEqual(texts(protocol(protocolTree(3, 3, 3)), "FAIL"), []);
    assert.deepEqual(texts(protocol(protocolTree(4, 4)), "FAIL"), []);
  });

  test("fails when the oldest served is above the protocol of the latest tag", () => {
    const findings = protocol(protocolTree(6, 4, 3));
    assert.deepEqual(texts(findings, "FAIL"), [
      "OLDEST_SERVED_PROTOCOL 4 is above the PROTOCOL_VERSION 3 of v0.4.1 (current 6): the extension would not serve the server of v0.4.1",
    ]);
    assert.deepEqual(texts(findings, "INFO"), ["protocol 6, oldest served 4, v0.4.1 has 3"]);
  });

  test("fails when the oldest served is above the current protocol", () => {
    assert.deepEqual(texts(protocol(protocolTree(6, 7)), "FAIL"), [
      "OLDEST_SERVED_PROTOCOL 7 is above PROTOCOL_VERSION 6",
    ]);
    assert.deepEqual(texts(protocol(protocolTree(6, 7, 6)), "FAIL"), [
      "OLDEST_SERVED_PROTOCOL 7 is above PROTOCOL_VERSION 6",
      "OLDEST_SERVED_PROTOCOL 7 is above the PROTOCOL_VERSION 6 of v0.4.1 (current 6): the extension would not serve the server of v0.4.1",
    ]);
  });

  test("fails when the current protocol is below that of the latest tag", () => {
    assert.deepEqual(texts(protocol(protocolTree(2, 2, 3)), "FAIL"), [
      "PROTOCOL_VERSION 2 is below the PROTOCOL_VERSION 3 of v0.4.1: the number never goes down",
    ]);
  });

  test("a constant missing from the working tree is one FAIL, and the rest is still read", () => {
    const noCurrent = protocolTree(6, 3, 3);
    noCurrent.files[PROTOCOL] = "export const OLDEST_SERVED_PROTOCOL = 4;\n";
    assert.deepEqual(protocol(noCurrent), [
      { level: "FAIL", text: `working tree: ${missing("PROTOCOL_VERSION")}` },
      {
        level: "FAIL",
        text: "OLDEST_SERVED_PROTOCOL 4 is above the PROTOCOL_VERSION 3 of v0.4.1: the extension would not serve the server of v0.4.1",
      },
    ]);
    assert.deepEqual(protocol(protocolTree(6, undefined, 3)), [
      { level: "FAIL", text: `working tree: ${missing("OLDEST_SERVED_PROTOCOL")}` },
    ]);
  });

  test("a missing protocol file is one FAIL", () => {
    const tree = protocolTree(6, 3, 3);
    delete tree.files[PROTOCOL];
    assert.deepEqual(protocol(tree), [
      { level: "FAIL", text: `protocol source: ENOENT: ${PROTOCOL}` },
    ]);
  });

  test("a tag whose file has no PROTOCOL_VERSION is one FAIL, and the numbers still print", () => {
    const tree = protocolTree(6, 3, 3);
    tree.commands[show(`refs/tags/${TAGGED}`, PROTOCOL)] = "export const NOTHING = 3;\n";
    assert.deepEqual(protocol(tree), [
      { level: "FAIL", text: `tag v0.4.1: ${missing("PROTOCOL_VERSION")}` },
      { level: "INFO", text: "protocol 6, oldest served 3" },
    ]);
  });

  test("a failing git show is one FAIL naming the tag", () => {
    const tree = protocolTree(6, 3, 3);
    delete tree.commands[show(`refs/tags/${TAGGED}`, PROTOCOL)];
    assert.deepEqual(texts(protocol(tree), "FAIL"), [
      `tag v0.4.1: \`git show refs/tags/v0.4.1:${PROTOCOL}\` failed (status 1): not scripted in the test`,
    ]);
  });

  test("a failing tag listing is one FAIL, and no tag is read", () => {
    const tree = protocolTree(6, 3, 3);
    tree.commands[TAGS] = new CommandError("git tag", 128, "fatal: broken");
    const env = fakeEnv(tree);
    assert.deepEqual(checkProtocol(env), [
      { level: "FAIL", text: "latest tag: `git tag` failed (status 128): fatal: broken" },
      { level: "INFO", text: "protocol 6, oldest served 3" },
    ]);
    assert.ok(!env.calls.some((call) => call[1] === "show"));
  });

  test("a malformed tag is reported once and the valid one is used", () => {
    const tree = protocolTree(6, 3, 3);
    tree.commands[TAGS] = "v0.4.1\nv0.5.0-rc";
    const findings = protocol(tree);
    assert.deepEqual(texts(findings, "FAIL"), ['the tag "v0.5.0-rc" is not a release tag vX.Y.Z']);
    assert.deepEqual(texts(findings, "INFO"), ["protocol 6, oldest served 3, v0.4.1 has 3"]);
  });

  const unanchored: [string, string][] = [
    ["commented out", "// export const PROTOCOL_VERSION = 6;"],
    ["indented", "  export const PROTOCOL_VERSION = 6;"],
    ["followed by a comment", "export const PROTOCOL_VERSION = 6; // current"],
    ["with a leading zero", "export const PROTOCOL_VERSION = 06;"],
    ["not an integer", "export const PROTOCOL_VERSION = 6.5;"],
    ["a longer name", "export const PROTOCOL_VERSION_NEXT = 6;"],
    ["not exported", "const PROTOCOL_VERSION = 6;"],
  ];
  for (const [name, line] of unanchored) {
    test(`a constant line that is ${name} does not count`, () => {
      const tree = protocolTree(6, 3, 3);
      tree.files[PROTOCOL] = `${line}\nexport const OLDEST_SERVED_PROTOCOL = 3;\n`;
      assert.deepEqual(texts(protocol(tree), "FAIL"), [
        `working tree: ${missing("PROTOCOL_VERSION")}`,
      ]);
    });
  }

  test("a constant line is found after other lines", () => {
    const tree = protocolTree(6, 3, 3);
    tree.files[PROTOCOL] = [
      "// export const PROTOCOL_VERSION = 9;",
      "/**",
      " * export const PROTOCOL_VERSION = 8;",
      " */",
      "",
      "export const OLDEST_SERVED_PROTOCOL = 3;",
      "export const PROTOCOL_VERSION = 6;",
      "export const PROTOCOL_VERSION_NEXT = 7;",
    ].join("\n");
    assert.deepEqual(protocol(tree), [
      { level: "INFO", text: "protocol 6, oldest served 3, v0.4.1 has 3" },
    ]);
  });

  test("a second constant line, as in a block comment, is one FAIL and no number", () => {
    const tree = protocolTree(6, 3, 3);
    tree.files[PROTOCOL] = [
      "export const PROTOCOL_VERSION = 6;",
      "/*",
      "export const OLDEST_SERVED_PROTOCOL = 3;",
      "*/",
      "export const OLDEST_SERVED_PROTOCOL = 5;",
    ].join("\n");
    assert.deepEqual(protocol(tree), [
      {
        level: "FAIL",
        text: `working tree: 2 lines declare OLDEST_SERVED_PROTOCOL in ${PROTOCOL}: expected one`,
      },
    ]);
    tree.files[PROTOCOL] = protocolSource(6, 3);
    tree.commands[show(`refs/tags/${TAGGED}`, PROTOCOL)] =
      `${protocolSource(3)}/*\nexport const PROTOCOL_VERSION = 2;\n*/\n`;
    assert.deepEqual(protocol(tree), [
      {
        level: "FAIL",
        text: `tag v0.4.1: 2 lines declare PROTOCOL_VERSION in ${PROTOCOL}: expected one`,
      },
      { level: "INFO", text: "protocol 6, oldest served 3" },
    ]);
  });

  const otherDeclarations: [string, string][] = [
    ["with a type", "export const OLDEST_SERVED_PROTOCOL: number = 7;"],
    ["indented", "  export const OLDEST_SERVED_PROTOCOL = 7;"],
    ["not exported", "const OLDEST_SERVED_PROTOCOL = 7;"],
    ["a let", "export let OLDEST_SERVED_PROTOCOL = 7;"],
    ["a var", "var OLDEST_SERVED_PROTOCOL = 7;"],
  ];
  for (const [name, declaration] of otherDeclarations) {
    test(`a declaration ${name} beside a commented-out copy is one FAIL`, () => {
      const tree = protocolTree(6, 3, 3);
      tree.files[PROTOCOL] = [
        "export const PROTOCOL_VERSION = 6;",
        "/*",
        "export const OLDEST_SERVED_PROTOCOL = 3;",
        "*/",
        declaration,
      ].join("\n");
      assert.deepEqual(texts(protocol(tree), "FAIL"), [
        `working tree: 2 lines declare OLDEST_SERVED_PROTOCOL in ${PROTOCOL}: expected one`,
      ]);
    });
  }

  test("pre-roll reports the same FAIL, using the tag it already read", () => {
    const tree = secondReleaseTree();
    tree.files[PROTOCOL] = protocolSource(6, 4);
    assert.deepEqual(texts(preRoll(tree, "minor"), "FAIL"), [
      "OLDEST_SERVED_PROTOCOL 4 is above the PROTOCOL_VERSION 3 of v0.1.0 (current 6): the extension would not serve the server of v0.1.0",
    ]);
  });

  test("pre-roll reports a malformed tag once", () => {
    const tree = secondReleaseTree();
    tree.commands[TAGS] = "v0.0.9\nv0.1.0-rc\nv0.1.0";
    const env = fakeEnv(tree);
    const result = checkPreRoll(env, "minor");
    assert.ok("findings" in result);
    assert.deepEqual(
      texts(result.findings, "FAIL").filter((text) => text.includes("not a release tag")),
      ['the tag "v0.1.0-rc" is not a release tag vX.Y.Z'],
    );
    assert.equal(env.calls.filter((call) => call.includes("--merged")).length, 1);
  });

  test("listing does not run the protocol check", () => {
    const tree = firstReleaseTree();
    delete tree.files[PROTOCOL];
    assert.deepEqual(texts(checkListing(fakeEnv(tree)), "FAIL"), []);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("post-roll", () => {
  for (const release of ["first", "second"] as const) {
    test(`passes on the ${release} release`, () => {
      assertClean(
        checkPostRoll(fakeEnv(postRollTree(release)), release === "first" ? "0.1.0" : "0.2.0"),
      );
    });
  }

  const deviations: [string, (tree: Tree) => void, RegExp][] = [
    [
      "an edited entry",
      (t) =>
        (t.files["CHANGELOG.md"] = (t.files["CHANGELOG.md"] ?? "").replace("tab tools", "tools")),
      /^CHANGELOG\.md:7: the "## \[0\.2\.0\] - 2026-10-18" entries differ from the Unreleased entries at HEAD$/,
    ],
    [
      "a wrong date",
      (t) =>
        (t.files["CHANGELOG.md"] = (t.files["CHANGELOG.md"] ?? "").replace(TODAY, "2026-10-17")),
      /^CHANGELOG\.md:7: the top released section must read ## \[0\.2\.0\] - 2026-10-18, found "## \[0\.2\.0\] - 2026-10-17"$/,
    ],
    [
      "an edited older section",
      (t) =>
        (t.files["CHANGELOG.md"] = (t.files["CHANGELOG.md"] ?? "").replace(
          "The first release.",
          "Edited.",
        )),
      /^CHANGELOG\.md:15: the section "## \[0\.1\.0\] - 2026-10-01" differs from HEAD$/,
    ],
    [
      "an edited older header",
      (t) =>
        (t.files["CHANGELOG.md"] = (t.files["CHANGELOG.md"] ?? "").replace(
          "2026-10-01",
          "2026-09-30",
        )),
      /^CHANGELOG\.md:15: the section .* differs from HEAD$/,
    ],
    [
      "an edited preamble",
      (t) =>
        (t.files["CHANGELOG.md"] = (t.files["CHANGELOG.md"] ?? "").replace("All notable", "Every")),
      /^the text above the first section of CHANGELOG\.md differs from HEAD$/,
    ],
    [
      "a dropped older section",
      (t) =>
        (t.files["CHANGELOG.md"] = changelog(
          "## [Unreleased]",
          `## [0.2.0] - ${TODAY}\n\n${ENTRIES}`,
        )),
      /^CHANGELOG\.md has 0 sections below the new one, HEAD has 1 released sections$/,
    ],
    [
      "entries left in Unreleased",
      (t) =>
        (t.files["CHANGELOG.md"] = changelog(
          "## [Unreleased]\n\n### Fixed\n\n- Left.",
          `## [0.2.0] - ${TODAY}\n\n${ENTRIES}`,
          OLD_SECTION,
        )),
      /^the Unreleased section of CHANGELOG\.md is not empty$/,
    ],
    [
      "an extra modified file",
      (t) => (t.commands[STATUS] = " M CHANGELOG.md\n M package.json"),
      /^git status must list exactly \[" M CHANGELOG\.md"\], found \[" M CHANGELOG\.md"," M package\.json"\]$/,
    ],
    [
      "a staged CHANGELOG",
      (t) => (t.commands[STATUS] = "M  CHANGELOG.md"),
      /^git status must list exactly/,
    ],
    [
      "a hidden change",
      (t) => (t.commands[LS_FILES] = "S package.json"),
      /^"package\.json" is marked skip-worktree/,
    ],
    [
      "a latest tag other than the version",
      (t) => Object.assign(t.commands, { [TAGS]: "v0.0.9" }),
      /^the latest tag v0\.0\.9 does not match 0\.1\.0 \(the root package\.json version\)$/,
    ],
    [
      "a section below other than the version",
      (t) => {
        Object.assign(t.files, packageFiles("0.1.5"));
        t.commands[TAGS] = "";
      },
      /^the section below the new one is 0\.1\.0, expected 0\.1\.5 \(the root package\.json version\)$/,
    ],
    [
      "an invalid HEAD changelog",
      (t) => (t.commands[SHOW_CHANGELOG] = "## [Unreleased]\nstray\n"),
      /^HEAD:CHANGELOG\.md:2: not a section header/,
    ],
    [
      "a CHANGELOG with no released section",
      (t) => (t.files["CHANGELOG.md"] = changelog("## [Unreleased]")),
      /^CHANGELOG\.md has no released section; expected ## \[0\.2\.0\] - 2026-10-18$/,
    ],
  ];
  for (const [name, breakIt, pattern] of deviations) {
    test(`fails on ${name}`, () => {
      const tree = postRollTree("second");
      breakIt(tree);
      assertFail(checkPostRoll(fakeEnv(tree), "0.2.0"), pattern);
    });
  }

  test("an edited entry is the only FAIL", () => {
    const tree = postRollTree("second");
    tree.files["CHANGELOG.md"] = (tree.files["CHANGELOG.md"] ?? "").replace("tab tools", "tools");
    assert.equal(texts(checkPostRoll(fakeEnv(tree), "0.2.0"), "FAIL").length, 1);
  });

  test("an added older section fails once", () => {
    const tree = postRollTree("second");
    tree.files["CHANGELOG.md"] =
      `${tree.files["CHANGELOG.md"]}\n## [0.0.1] - 2026-09-01\n\n### Added\n\n- Old.\n`;
    assertOnlyFail(
      checkPostRoll(fakeEnv(tree), "0.2.0"),
      /^CHANGELOG\.md has 2 sections below the new one, HEAD has 1 released sections$/,
    );
  });

  test("a released section below the new one with no tag fails", () => {
    const tree = postRollTree("second");
    tree.commands[TAGS] = "";
    assertOnlyFail(
      checkPostRoll(fakeEnv(tree), "0.2.0"),
      /^CHANGELOG\.md:15: 0\.1\.0 is released, but no v\* tag is reachable from HEAD$/,
    );
  });

  test("the first release must be the current version", () => {
    const tree = postRollTree("first");
    tree.files["CHANGELOG.md"] = (tree.files["CHANGELOG.md"] ?? "").replace("[0.1.0]", "[0.2.0]");
    const fails = texts(checkPostRoll(fakeEnv(tree), "0.2.0"), "FAIL");
    assert.deepEqual(fails, ["the first release must be the current version 0.1.0, not 0.2.0"]);
  });

  function rolledTo(version: string, unreleased = ENTRIES): Finding[] {
    const tree = postRollTree("second");
    tree.commands[SHOW_CHANGELOG] = changelog(`## [Unreleased]\n\n${unreleased}`, OLD_SECTION);
    tree.files["CHANGELOG.md"] = changelog(
      "## [Unreleased]",
      `## [${version}] - ${TODAY}\n\n${unreleased}`,
      OLD_SECTION,
    );
    return checkPostRoll(fakeEnv(tree), version);
  }

  test("the version must be the bump the Unreleased changes at HEAD need, or a bigger one", () => {
    assertClean(rolledTo("1.0.0"));
    assertOnlyFail(
      rolledTo("0.1.1"),
      /^0\.1\.1 is not a minor bump or bigger from 0\.1\.0, which the Unreleased changes at HEAD need: expected 0\.2\.0 or 1\.0\.0$/,
    );
    assertOnlyFail(rolledTo("0.3.0"), /^0\.3\.0 is not a minor bump or bigger/);
    assertClean(rolledTo("0.1.1", "### Fixed\n\n- A fix."));
    assertOnlyFail(
      rolledTo("0.1.1", "### Removed\n\n- Gone."),
      /^0\.1\.1 is not a minor bump or bigger from 0\.1\.0/,
    );
    assertClean(rolledTo("0.2.0", "### Removed\n\n- Gone."));
  });
});

describe("post-bump", () => {
  test("passes on the first release with an unchanged tree", () => {
    assertClean(checkPostBump(fakeEnv(postBumpTree("first")), "0.1.0"));
  });

  test("passes on the second release with the six version files modified", () => {
    assertClean(checkPostBump(fakeEnv(postBumpTree("second")), "0.2.0"));
  });

  const deviations: [string, (tree: Tree) => void, RegExp][] = [
    [
      "a package left behind",
      (t) => Object.assign(t.files, packageFiles("0.2.0", { "apps/server/package.json": "0.1.0" })),
      /^apps\/server\/package\.json has version "0\.1\.0", expected 0\.2\.0/,
    ],
    [
      "an extra modified file",
      (t) => (t.commands[STATUS] = `${t.commands[STATUS]}\n M README.md`),
      /^git status must list exactly .*README/,
    ],
    [
      "a file missing from the bump",
      (t) => (t.commands[STATUS] = " M package.json"),
      /^git status must list exactly/,
    ],
    [
      "a top section other than the version",
      (t) => (t.files["CHANGELOG.md"] = changelog("## [Unreleased]", OLD_SECTION)),
      /^the top released section of CHANGELOG\.md is 0\.1\.0, expected 0\.2\.0$/,
    ],
    [
      "a latest tag other than the section below",
      (t) => (t.commands[TAGS] = "v0.0.9"),
      /^the latest tag v0\.0\.9 does not match the section below, 0\.1\.0$/,
    ],
    [
      "a latest tag with no section below",
      (t) =>
        (t.files["CHANGELOG.md"] = changelog(
          "## [Unreleased]",
          `## [0.2.0] - ${TODAY}\n\n${ENTRIES}`,
        )),
      /^the latest tag v0\.1\.0 has no released section below 0\.2\.0$/,
    ],
  ];
  for (const [name, breakIt, pattern] of deviations) {
    test(`fails on ${name}`, () => {
      const tree = postBumpTree("second");
      breakIt(tree);
      assertFail(checkPostBump(fakeEnv(tree), "0.2.0"), pattern);
    });
  }

  test("fails when the version is not the root version", () => {
    const fails = texts(checkPostBump(fakeEnv(postBumpTree("second")), "0.3.0"), "FAIL");
    assert.ok(
      fails.includes('the root package.json version is "0.2.0", expected 0.3.0'),
      JSON.stringify(fails),
    );
    assert.ok(fails.includes("the top released section of CHANGELOG.md is 0.2.0, expected 0.3.0"));
  });

  test("a released section below the new one with no tag fails", () => {
    const tree = postBumpTree("second");
    tree.commands[TAGS] = "";
    assertOnlyFail(
      checkPostBump(fakeEnv(tree), "0.2.0"),
      /^CHANGELOG\.md:15: 0\.1\.0 is released, but no v\* tag is reachable from HEAD$/,
    );
  });

  test("on the first release a modified package.json fails", () => {
    const tree = postBumpTree("first");
    tree.commands[STATUS] = " M package.json";
    assertOnlyFail(
      checkPostBump(fakeEnv(tree), "0.1.0"),
      /^git status must list exactly \[\], found/,
    );
  });
});

describe("pre-push", () => {
  for (const release of ["first", "second"] as const) {
    test(`passes on the ${release} release`, () => {
      assertClean(checkPrePush(fakeEnv(prePushTree(release))));
    });
  }

  const deviations: [string, (tree: Tree) => void, RegExp][] = [
    [
      "a missing commit",
      (t) => (t.commands[LOG] = "Update changelog for 0.2.0"),
      /^the commits on top of origin\/main must be \["Bump version to 0\.2\.0","Update changelog for 0\.2\.0"\] \(newest first\), found \["Update changelog for 0\.2\.0"\]$/,
    ],
    [
      "an extra commit",
      (t) => (t.commands[LOG] = "Fix\nBump version to 0.2.0\nUpdate changelog for 0.2.0"),
      /^the commits on top of origin\/main must be/,
    ],
    [
      "a wrong subject",
      (t) => (t.commands[LOG] = "Bump version to 0.2.0\nUpdate the changelog for 0.2.0"),
      /^the commits on top of origin\/main must be/,
    ],
    [
      "an unannotated tag",
      (t) => (t.commands[catFile("v0.2.0")] = "commit"),
      /^the tag v0\.2\.0 is not annotated; recreate it with git tag -a v0\.2\.0$/,
    ],
    [
      "another tag on HEAD after the release tag",
      (t) => (t.commands[POINTS_AT] = "v0.2.0\nother"),
      /^HEAD must carry exactly the tag v0\.2\.0, found \["v0\.2\.0","other"\]$/,
    ],
    [
      "an extra tag on HEAD",
      (t) => (t.commands[POINTS_AT] = "other\nv0.2.0"),
      /^HEAD must carry exactly the tag v0\.2\.0, found \["other","v0\.2\.0"\]$/,
    ],
    [
      "no tag on HEAD",
      (t) => (t.commands[POINTS_AT] = ""),
      /^HEAD must carry exactly the tag v0\.2\.0, found \[\]$/,
    ],
    [
      "the tag already on origin",
      (t) => (t.commands[lsRemote("v0.2.0")] = `${TAG_SHA}\trefs/tags/v0.2.0`),
      /^the tag v0\.2\.0 is already on origin$/,
    ],
    [
      "HEAD not descending from origin/main",
      (t) => (t.commands[ANCESTOR] = new CommandError("git merge-base", 1, "")),
      /^HEAD does not descend from origin\/main; rebase on it first$/,
    ],
    [
      "a broken ancestor check",
      (t) => (t.commands[ANCESTOR] = new CommandError("git merge-base", 128, "fatal: bad")),
      /^origin\/main: `git merge-base` failed \(status 128\): fatal: bad$/,
    ],
    [
      "a merge commit in the range",
      (t) => (t.commands[MERGES] = OTHER),
      /^the commits on top of origin\/main include merges: c+$/,
    ],
    [
      "a dirty tree",
      (t) => (t.commands[STATUS] = "?? x"),
      /^the working tree is not clean: "\?\? x"$/,
    ],
    [
      "a missing XPI",
      (t) => {
        delete t.files["artifacts/foxleash-0.2.0.xpi"];
        delete t.commands[unzipManifest("artifacts/foxleash-0.2.0.xpi")];
      },
      /^artifacts\/foxleash-0\.2\.0\.xpi is missing; run npm run build:amo$/,
    ],
    [
      "a missing source archive",
      (t) => delete t.files["artifacts/foxleash-source-0.2.0.zip"],
      /^artifacts\/foxleash-source-0\.2\.0\.zip is missing; run npm run build:amo$/,
    ],
    [
      "an XPI of another version",
      (t) =>
        (t.commands[unzipManifest("artifacts/foxleash-0.2.0.xpi")] = Buffer.from(
          json({ version: "0.1.0" }),
        )),
      /^artifacts\/foxleash-0\.2\.0\.xpi manifest\.json has version "0\.1\.0", expected 0\.2\.0$/,
    ],
    [
      "a source archive entry that differs from the tag",
      (t) => (t.commands[unzipEntry(SOURCE_ZIP, "apps/extension/src/background.ts")] = "evil();\n"),
      /^artifacts\/foxleash-source-0\.2\.0\.zip: apps\/extension\/src\/background\.ts differs from v0\.2\.0 \(a{12}\)$/,
    ],
    [
      "a tag that does not resolve to a commit",
      (t) =>
        (t.commands[key("git", "rev-parse", "refs/tags/v0.2.0^{commit}")] = new CommandError(
          "git rev-parse",
          128,
          "fatal: bad",
        )),
      /^artifacts\/foxleash-source-0\.2\.0\.zip: `git rev-parse` failed \(status 128\): fatal: bad$/,
    ],
    [
      "a source archive README.md with a line added",
      (t) =>
        (t.commands[unzipEntry(SOURCE_ZIP, "README.md")] =
          "Node 24.11.0, npm 11.6.2\nRun npm ci --ignore-scripts=false.\n"),
      /^artifacts\/foxleash-source-0\.2\.0\.zip: README\.md is not the README of v0\.2\.0 \(a{12}\) with a Node and an npm version filled in$/,
    ],
    [
      "a source archive without README.md",
      (t) =>
        (t.commands[key("unzip", "-Z1", "-UU", SOURCE_ZIP)] = Object.keys(SOURCE_FILES).join("\n")),
      /^artifacts\/foxleash-source-0\.2\.0\.zip lacks README\.md$/,
    ],
    [
      "a source archive that lacks a shipped file",
      (t) =>
        (t.commands[key("unzip", "-Z1", "-UU", SOURCE_ZIP)] =
          ".nvmrc\nREADME.md\napps/extension/manifest.json"),
      /^artifacts\/foxleash-source-0\.2\.0\.zip lacks apps\/extension\/src\/background\.ts, which v0\.2\.0 \(a{12}\) ships$/,
    ],
    [
      "a source archive entry the tag does not ship",
      (t) =>
        (t.commands[key("unzip", "-Z1", "-UU", SOURCE_ZIP)] =
          `${t.commands[key("unzip", "-Z1", "-UU", SOURCE_ZIP)]}\nCHANGELOG.md`),
      /^artifacts\/foxleash-source-0\.2\.0\.zip: CHANGELOG\.md is not a file v0\.2\.0 \(a{12}\) ships$/,
    ],
    [
      "an unreadable README template at the tag",
      (t) => delete t.commands[catBlob(HEAD, SOURCE_TEMPLATE)],
      /^bin\/amo-source-readme\.md at v0\.2\.0 \(a{12}\): `git cat-file blob a+:bin\/amo-source-readme\.md` failed/,
    ],
    [
      "a list at the tag naming a file the ship rules do not ship",
      (t) =>
        (t.commands[catBlob(HEAD, AMO_SOURCES)] =
          `${t.commands[catBlob(HEAD, AMO_SOURCES)]}apps/extension/src/a.test.ts\n`),
      /^bin\/amo-source-files\.txt at v0\.2\.0 \(a{12}\) lists apps\/extension\/src\/a\.test\.ts, which the ship rules of this checkout do not ship$/,
    ],
    [
      "a list at the tag lacking a file the ship rules ship",
      (t) =>
        (t.commands[catBlob(HEAD, AMO_SOURCES)] =
          ".nvmrc\nREADME.md\napps/extension/manifest.json\n"),
      /^bin\/amo-source-files\.txt at v0\.2\.0 \(a{12}\) does not list apps\/extension\/src\/background\.ts, which the ship rules of this checkout ship$/,
    ],
    [
      "an unreadable list at the tag",
      (t) => delete t.commands[catBlob(HEAD, AMO_SOURCES)],
      /^bin\/amo-source-files\.txt at v0\.2\.0 \(a{12}\): `git cat-file blob a+:bin\/amo-source-files\.txt` failed/,
    ],
    [
      "entries left in Unreleased",
      (t) =>
        (t.files["CHANGELOG.md"] = changelog(
          "## [Unreleased]\n\n### Fixed\n\n- Left.",
          `## [0.2.0] - ${TODAY}\n\n${ENTRIES}`,
          OLD_SECTION,
        )),
      /^the Unreleased section of CHANGELOG\.md is not empty$/,
    ],
    [
      "a CHANGELOG with no sections below Unreleased",
      (t) => (t.files["CHANGELOG.md"] = changelog("## [Unreleased]")),
      /^CHANGELOG\.md has no released section$/,
    ],
    [
      "a top section other than the version",
      (t) => (t.files["CHANGELOG.md"] = changelog("## [Unreleased]", OLD_SECTION)),
      /^the top released section of CHANGELOG\.md is 0\.1\.0, expected 0\.2\.0/,
    ],
    [
      "a latest tag other than the version",
      (t) => (t.commands[TAGS] = "v0.1.0"),
      /^the latest tag v0\.1\.0 does not match 0\.2\.0/,
    ],
    [
      "a failed fetch",
      (t) => (t.commands[FETCH] = new CommandError("git fetch", 128, "fatal: offline")),
      /^fetch: `git fetch` failed \(status 128\): fatal: offline$/,
    ],
    [
      "a push URL to another repository",
      (t) => (t.commands[PUSH_URL] = "git@github.com:owner/fork.git"),
      /^origin fetches from .* but pushes to/,
    ],
    ["main", (t) => (t.commands[BRANCH] = "main"), /^on branch "main", not release\/0\.2\.0$/],
    [
      "another version's release branch",
      (t) => (t.commands[BRANCH] = "release/0.1.0"),
      /^on branch "release\/0\.1\.0", not release\/0\.2\.0$/,
    ],
    [
      "a branch named release",
      (t) => (t.commands[BRANCH] = "release"),
      /^on branch "release", not release\/0\.2\.0$/,
    ],
    [
      "an ambiguous name",
      (t) => (t.commands[BRANCH] = "heads/release/0.2.0"),
      /^on branch "heads\/release\/0\.2\.0", not release\/0\.2\.0$/,
    ],
    [
      "a detached HEAD",
      (t) => (t.commands[BRANCH] = "HEAD"),
      /^HEAD is detached; check out release\/0\.2\.0$/,
    ],
    [
      "local main ahead of origin/main",
      (t) => (t.commands[MAIN_AHEAD] = `${HEAD}\n${OTHER}`),
      new RegExp(`^local main has commits that origin/main does not: ${HEAD}, ${OTHER}$`),
    ],
    [
      "a failed CI run on origin/main",
      (t) => (t.commands[ghRuns(OTHER)] = runs(ciRun({ head_sha: OTHER, conclusion: "failure" }))),
      /^CI run 101 \(push\) for c{12} failed: failure$/,
    ],
    [
      "no CI run on origin/main",
      (t) => (t.commands[ghRuns(OTHER)] = runs(ciRun())),
      /^no CI run on main for c{12}/,
    ],
    [
      "another file in the release commits",
      (t) => (t.commands[DIFF_TREE] = `${t.commands[DIFF_TREE]}\napps/server/src/extra.ts`),
      /^the release commits must change exactly \[.*\], found \[.*"apps\/server\/src\/extra\.ts".*\]$/,
    ],
    [
      "another file in place of a version file",
      (t) =>
        (t.commands[DIFF_TREE] = ["CHANGELOG.md", ...VERSION_FILES]
          .join("\n")
          .replace("apps/server/package.json", "apps/server/src/extra.ts")),
      /^the release commits must change exactly .*, found \[.*"apps\/server\/src\/extra\.ts".*\]$/,
    ],
    [
      "a version file left out of the release commits",
      (t) => (t.commands[DIFF_TREE] = ["CHANGELOG.md", ...VERSION_FILES.slice(1)].join("\n")),
      /^the release commits must change exactly/,
    ],
    [
      "a lockfile change beyond the versions",
      (t) =>
        (t.commands[show("HEAD", "package-lock.json")] = (
          t.files["package-lock.json"] ?? ""
        ).replace('"lockfileVersion": 3', '"lockfileVersion": 4')),
      /^package-lock\.json changes more than its version since origin\/main$/,
    ],
    [
      "a package change beyond the version",
      (t) =>
        (t.commands[show("HEAD", "apps/server/package.json")] = json({
          name: "apps/server",
          version: "0.2.0",
          scripts: { postinstall: "x" },
        })),
      /^apps\/server\/package\.json changes more than its version since origin\/main$/,
    ],
    [
      "a duplicate key that JSON.parse hides",
      (t) =>
        (t.commands[show("HEAD", "apps/server/package.json")] = (
          t.files["apps/server/package.json"] ?? ""
        ).replace("{\n", '{\n  "name": "other",\n')),
      /^apps\/server\/package\.json changes more than its version since origin\/main$/,
    ],
    [
      "a duplicate key on the line of another",
      (t) =>
        (t.commands[show("HEAD", "apps/server/package.json")] = (
          t.files["apps/server/package.json"] ?? ""
        ).replace('  "name": "apps/server",', '  "name": "other", "name": "apps/server",')),
      /^apps\/server\/package\.json changes more than its version since origin\/main$/,
    ],
    [
      "a dependency version changed with the release versions",
      (t) => {
        const withDependency = (text: string, version: string): string => {
          const lock = JSON.parse(text);
          lock.packages["node_modules/x"] = { version };
          return json(lock);
        };
        const origin = show("refs/remotes/origin/main", "package-lock.json");
        t.commands[origin] = withDependency(String(t.commands[origin]), "1.0.0");
        const head = show("HEAD", "package-lock.json");
        t.commands[head] = withDependency(String(t.commands[head]), "0.2.0");
      },
      /^package-lock\.json changes more than its version since origin\/main$/,
    ],
    [
      "a version bump smaller than origin/main's Unreleased changes need",
      (t) => (t.commands[SHOW_ORIGIN_PACKAGE] = packageFiles("0.0.5")["package.json"] ?? ""),
      /^0\.2\.0 is not a minor bump or bigger from 0\.0\.5, which the Unreleased changes at origin\/main need: expected 0\.1\.0 or 1\.0\.0$/,
    ],
    [
      "a malformed version at origin/main",
      (t) => (t.commands[SHOW_ORIGIN_PACKAGE] = packageFiles("01.0.0")["package.json"] ?? ""),
      /^refs\/remotes\/origin\/main:package\.json has version "01\.0\.0", not x\.y\.z$/,
    ],
    [
      "an invalid CHANGELOG.md at origin/main",
      (t) =>
        (t.commands[show("refs/remotes/origin/main", "CHANGELOG.md")] = "## [Unreleased]\nstray\n"),
      /^origin\/main:CHANGELOG\.md:2: not a section header/,
    ],
    [
      "a version file that is not JSON",
      (t) => {
        t.commands[show("refs/remotes/origin/main", "package-lock.json")] = "{";
        t.commands[show("HEAD", "package-lock.json")] = "{";
      },
      /^release commits: /,
    ],
  ];
  for (const [name, breakIt, pattern] of deviations) {
    test(`fails on ${name}`, () => {
      const tree = prePushTree("second");
      breakIt(tree);
      assertOnlyFail(checkPrePush(fakeEnv(tree)), pattern);
    });
  }

  test("the first release expects only the changelog commit", () => {
    const tree = prePushTree("first");
    tree.commands[LOG] = "Bump version to 0.1.0\nUpdate changelog for 0.1.0";
    assertOnlyFail(checkPrePush(fakeEnv(tree)), /must be \["Update changelog for 0\.1\.0"\]/);
  });

  test("the first release may change only CHANGELOG.md", () => {
    const tree = prePushTree("first");
    tree.commands[DIFF_TREE] = "CHANGELOG.md\npackage.json";
    assertOnlyFail(
      checkPrePush(fakeEnv(tree)),
      /^the release commits must change exactly \["CHANGELOG\.md"\], found \["CHANGELOG\.md","package\.json"\]$/,
    );
  });

  test("checks CI for origin/main, not for HEAD", () => {
    const env = fakeEnv(prePushTree("second"));
    const findings = checkPrePush(env);
    assertClean(findings);
    assert.ok(
      texts(findings, "INFO").includes(`CI run 101 (push) green for ${OTHER.slice(0, 12)}`),
    );
    assert.ok(!env.calls.some((call) => call.join(" ").includes(`head_sha=${HEAD}`)));
  });

  test("a version that is not x.y.z skips the branch check", () => {
    const tree = prePushTree("second");
    Object.assign(tree.files, packageFiles("0.2.0", { "package.json": "0.2" }));
    tree.commands[BRANCH] = "main";
    const fails = texts(checkPrePush(fakeEnv(tree)), "FAIL");
    assert.ok(fails.includes('package.json has version "0.2", not x.y.z'), JSON.stringify(fails));
    assert.ok(
      !fails.some((text) => text.startsWith("on branch") || text.startsWith("HEAD is detached")),
      JSON.stringify(fails),
    );
  });

  test("a missing tag skips the annotation check", () => {
    const tree = prePushTree("second");
    tree.commands[POINTS_AT] = "v0.1.0";
    const env = fakeEnv(tree);
    checkPrePush(env);
    assert.ok(!env.calls.some((call) => call.includes("cat-file") && call.includes("-t")));
  });
});

describe("npm audit", () => {
  const stages: { name: string; tree: () => Tree; run: (env: FakeEnv) => Finding[] }[] = [
    {
      name: "pre-roll",
      tree: firstReleaseTree,
      run(env) {
        const result = checkPreRoll(env, undefined);
        assert.ok("findings" in result, JSON.stringify(result));
        return result.findings;
      },
    },
    { name: "pre-push", tree: () => prePushTree("first"), run: (env) => checkPrePush(env) },
  ];
  const LEFT_PAD: Advisory = {
    name: "left-pad",
    severity: "low",
    title: "Slow padding",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  };
  const SEMVER: Advisory = {
    name: "semver",
    severity: "moderate",
    title: "Regular expression denial of service",
    url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
  };
  const KIND: Advisory = {
    name: "kind-of",
    severity: "info",
    title: "A note",
    url: "https://github.com/advisories/GHSA-gggg-hhhh-iiii",
  };
  const CHALK_FAIL = `npm audit: chalk has a critical advisory: Malware in chalk ${CHALK.url}`;
  const UA_PARSER_FAIL = `npm audit: ua-parser-js has a high advisory: Embedded malware in ua-parser-js ${UA_PARSER.url}`;

  /** The findings of `stage` when `npm audit` answers `reply`, and the commands it ran. */
  function audited(
    stage: (typeof stages)[number],
    reply: Reply,
  ): { findings: Finding[]; env: FakeEnv } {
    const tree = stage.tree();
    tree.commands[AUDIT] = reply;
    const env = fakeEnv(tree);
    return { findings: stage.run(env), env };
  }

  for (const stage of stages) {
    describe(stage.name, () => {
      test("fails on a critical and a high advisory, naming each package and its link", () => {
        const { findings } = audited(stage, json(auditReport(UA_PARSER, CHALK)));
        assert.deepEqual(texts(findings, "FAIL"), [CHALK_FAIL, UA_PARSER_FAIL]);
        assert.ok(!texts(findings, "INFO").includes("npm audit: no advisories"));
      });

      test("passes a clean report with one INFO line", () => {
        const { findings } = audited(stage, json(auditReport()));
        assertClean(findings);
        assert.deepEqual(
          texts(findings, "INFO").filter((text) => text.startsWith("npm audit:")),
          ["npm audit: no advisories"],
        );
      });

      test("prints low, moderate and info advisories as INFO and passes", () => {
        const { findings } = audited(stage, json(auditReport(KIND, LEFT_PAD, SEMVER)));
        assertClean(findings);
        assert.deepEqual(
          texts(findings, "INFO").filter((text) => text.startsWith("npm audit:")),
          [
            `npm audit: semver has a moderate advisory: ${SEMVER.title} ${SEMVER.url}`,
            `npm audit: left-pad has a low advisory: ${LEFT_PAD.title} ${LEFT_PAD.url}`,
            `npm audit: kind-of has a info advisory: ${KIND.title} ${KIND.url}`,
          ],
        );
      });

      test("fails on a high advisory next to lower ones, and prints the lower ones", () => {
        const { findings } = audited(stage, json(auditReport(LEFT_PAD, UA_PARSER)));
        assert.deepEqual(texts(findings, "FAIL"), [UA_PARSER_FAIL]);
        assert.ok(
          texts(findings, "INFO").includes(
            `npm audit: left-pad has a low advisory: ${LEFT_PAD.title} ${LEFT_PAD.url}`,
          ),
        );
      });

      const failures: [string, CommandError, RegExp][] = [
        [
          "the registry cannot be reached",
          new CommandError(
            "npm audit --json",
            1,
            "npm warn audit request failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n",
          ),
          /^npm audit: `npm audit --json` failed \(status 1\): .*ENOTFOUND registry\.npmjs\.org$/,
        ],
        [
          "it times out",
          new CommandError("npm audit --json", null, "", "error spawnSync npm ETIMEDOUT"),
          /^npm audit: `npm audit --json` failed \(error spawnSync npm ETIMEDOUT\): $/,
        ],
        [
          "there is no lockfile",
          new CommandError("npm audit --json", 1, "npm error code ENOLOCK\n"),
          /^npm audit: `npm audit --json` failed \(status 1\): npm error code ENOLOCK$/,
        ],
      ];
      for (const [name, error, pattern] of failures) {
        test(`fails when ${name}`, () => {
          const { findings } = audited(stage, error);
          assertOnlyFail(findings, pattern);
          assert.ok(!texts(findings, "INFO").includes("npm audit: no advisories"));
        });
      }

      const entry = auditEntry(UA_PARSER);
      const [item] = entry.via;
      assert.ok(item);
      const { url: _url, ...withoutUrl } = item;
      const unusable: [string, unknown, RegExp][] = [
        ["not JSON", "npm warn deprecated\n", /^npm audit printed no JSON report: "npm warn dep/],
        ["no output", "", /^npm audit printed no JSON report: ""$/],
        ["null", "null", /^unexpected npm audit output: the report is not an object$/],
        ["a list", "[]", /^unexpected npm audit output: the report is not an object$/],
        [
          "an empty object",
          {},
          /^unexpected npm audit output: auditReportVersion is undefined, not 2$/,
        ],
        [
          "version 1",
          { ...auditReport(), auditReportVersion: 1 },
          /^unexpected npm audit output: auditReportVersion is 1, not 2$/,
        ],
        [
          "an error next to a clean report",
          { ...auditReport(), error: { code: "EAUDIT", summary: "audit failed" } },
          /^unexpected npm audit output: the report holds an error$/,
        ],
        [
          "no vulnerabilities",
          { auditReportVersion: 2, metadata: auditReport().metadata },
          /^unexpected npm audit output: vulnerabilities is not an object$/,
        ],
        [
          "vulnerabilities as a list",
          { ...auditReport(), vulnerabilities: [] },
          /^unexpected npm audit output: vulnerabilities is not an object$/,
        ],
        [
          "an unknown severity on an entry",
          auditReportOf({ "ua-parser-js": { ...entry, severity: "severe" } }, NO_COUNTS),
          /^unexpected npm audit output: vulnerabilities\.ua-parser-js has no name, severity and via list$/,
        ],
        [
          "an entry that is no object",
          auditReportOf({ "ua-parser-js": "high" }, NO_COUNTS),
          /^unexpected npm audit output: vulnerabilities\.ua-parser-js has no name, severity and via list$/,
        ],
        [
          "an entry without a name",
          auditReportOf({ x: { ...entry, name: undefined } }, { ...NO_COUNTS, high: 1 }),
          /^unexpected npm audit output: vulnerabilities\.x has no name, severity and via list$/,
        ],
        [
          "an entry whose via is no list",
          auditReportOf({ x: { ...entry, via: "chalk" } }, { ...NO_COUNTS, high: 1 }),
          /^unexpected npm audit output: vulnerabilities\.x has no name, severity and via list$/,
        ],
        [
          "an unknown severity on an advisory",
          auditReportOf(
            { "ua-parser-js": { ...entry, via: [{ ...item, severity: "severe" }] } },
            { ...NO_COUNTS, high: 1 },
          ),
          /^unexpected npm audit output: vulnerabilities\.ua-parser-js\.via has an item that is no package name or advisory$/,
        ],
        [
          "an advisory without a url",
          auditReportOf(
            { "ua-parser-js": { ...entry, via: [withoutUrl] } },
            { ...NO_COUNTS, high: 1 },
          ),
          /^unexpected npm audit output: vulnerabilities\.ua-parser-js\.via has an item that is no package name or advisory$/,
        ],
        [
          "an advisory without a title",
          auditReportOf(
            { "ua-parser-js": { ...entry, via: [{ ...item, title: 7 }] } },
            { ...NO_COUNTS, high: 1 },
          ),
          /via has an item that is no package name or advisory$/,
        ],
        [
          "an advisory without a package",
          auditReportOf(
            { "ua-parser-js": { ...entry, via: [{ ...item, name: undefined }] } },
            { ...NO_COUNTS, high: 1 },
          ),
          /via has an item that is no package name or advisory$/,
        ],
        [
          "a via item that is a number",
          auditReportOf({ x: { ...entry, via: [3] } }, { ...NO_COUNTS, high: 1 }),
          /^unexpected npm audit output: vulnerabilities\.x\.via has an item that is no package name or advisory$/,
        ],
        [
          "no metadata",
          { auditReportVersion: 2, vulnerabilities: {} },
          /^unexpected npm audit output: metadata\.vulnerabilities is not an object$/,
        ],
        [
          "a high count with no entry",
          auditReportOf({}, { ...NO_COUNTS, high: 1 }),
          /^unexpected npm audit output: metadata\.vulnerabilities\.high is 1, but the entries hold 0$/,
        ],
        [
          "a critical entry counted as high",
          auditReportOf({ chalk: auditEntry(CHALK) }, { ...NO_COUNTS, high: 1 }),
          /^unexpected npm audit output: metadata\.vulnerabilities\.high is 1, but the entries hold 0$/,
        ],
        [
          "a count that is a string",
          auditReportOf({ "ua-parser-js": entry }, { ...NO_COUNTS, high: "1" }),
          /^unexpected npm audit output: metadata\.vulnerabilities\.high is "1", but the entries hold 1$/,
        ],
        [
          "a missing count",
          auditReportOf({}, { info: 0, low: 0, moderate: 0, high: 0 }),
          /^unexpected npm audit output: metadata\.vulnerabilities\.critical is undefined, but the entries hold 0$/,
        ],
        [
          "a critical entry with no advisory",
          auditReportOf(
            { chalk: { ...auditEntry(CHALK), via: [] } },
            { ...NO_COUNTS, critical: 1 },
          ),
          /^unexpected npm audit output: the entries go up to critical, but the advisories up to none$/,
        ],
        [
          "a critical entry whose only advisory is low",
          auditReportOf(
            { chalk: { ...auditEntry(CHALK), via: [{ ...item, severity: "low" }] } },
            { ...NO_COUNTS, critical: 1 },
          ),
          /^unexpected npm audit output: the entries go up to critical, but the advisories up to low$/,
        ],
        [
          "a high advisory in a low entry",
          auditReportOf({ x: { ...entry, severity: "low" } }, { ...NO_COUNTS, low: 1 }),
          /^unexpected npm audit output: the entries go up to low, but the advisories up to high$/,
        ],
      ];
      for (const [name, reply, pattern] of unusable) {
        test(`fails on unusable output: ${name}`, () => {
          const { findings } = audited(stage, typeof reply === "string" ? reply : json(reply));
          assertOnlyFail(findings, pattern);
          assert.ok(!texts(findings, "INFO").includes("npm audit: no advisories"));
        });
      }

      test("quotes the first 200 characters of output that is no JSON", () => {
        const { findings } = audited(stage, `${"x".repeat(200)}tail`);
        assert.deepEqual(texts(findings, "FAIL"), [
          `npm audit printed no JSON report: "${"x".repeat(200)}..."`,
        ]);
        assert.deepEqual(texts(audited(stage, "x".repeat(200)).findings, "FAIL"), [
          `npm audit printed no JSON report: "${"x".repeat(200)}"`,
        ]);
      });

      test("fails once for a package that is vulnerable only through a dependency", () => {
        const parent = { ...auditEntry(UA_PARSER), name: "parent", via: ["ua-parser-js"] };
        const report = auditReportOf(
          { parent, "ua-parser-js": auditEntry(UA_PARSER) },
          { ...NO_COUNTS, high: 2 },
        );
        const { findings } = audited(stage, json(report));
        assert.deepEqual(texts(findings, "FAIL"), [UA_PARSER_FAIL]);
      });

      test("runs npm audit once, with the lockfile-only, include, offline and workspace flags", () => {
        const { env } = audited(stage, json(auditReport()));
        assert.deepEqual(
          env.calls.filter(([command]) => command === "npm"),
          [JSON.parse(AUDIT)],
        );
      });
    });
  }

  test("auditAdvisories lists each advisory once, highest severity first, then by package", () => {
    const shared = auditEntry(SEMVER);
    const report = auditReportOf(
      {
        zlib: auditEntry({ ...LEFT_PAD, name: "zlib" }),
        semver: shared,
        "semver-again": { ...shared, name: "semver-again", via: [...shared.via, "semver"] },
        chalk: auditEntry(CHALK),
        "left-pad": auditEntry(LEFT_PAD),
        "ua-parser-js": auditEntry(UA_PARSER),
        "another-high": auditEntry({ ...UA_PARSER, name: "another-high" }),
      },
      { ...NO_COUNTS, critical: 1, high: 2, moderate: 2, low: 2 },
    );
    const advisories = auditAdvisories(report);
    assert.ok(Array.isArray(advisories), String(advisories));
    assert.deepEqual(
      advisories.map(({ name, severity }) => `${name} ${severity}`),
      [
        "chalk critical",
        "another-high high",
        "ua-parser-js high",
        "semver moderate",
        "left-pad low",
        "zlib low",
      ],
    );
    assert.deepEqual(advisories[3], SEMVER);
  });

  test("auditAdvisories refuses a package vulnerable through a dependency that has no entry", () => {
    const parent = { ...auditEntry(UA_PARSER), name: "parent", via: ["ua-parser-js"] };
    assert.equal(
      auditAdvisories(auditReportOf({ parent }, { ...NO_COUNTS, high: 1 })),
      "the entries go up to high, but the advisories up to none",
    );
  });

  test("a title with a line break cannot print a line of its own", () => {
    const tree = firstReleaseTree();
    tree.commands[AUDIT] = json(auditReport({ ...UA_PARSER, title: "Bad\nINFO: forged line" }));
    const out: string[] = [];
    const status = runCli(["pre-roll"], fakeEnv(tree), {
      out: (line) => out.push(line),
      err: () => {},
    });
    assert.equal(status, 1);
    assert.ok(
      out.includes(
        `FAIL: npm audit: ua-parser-js has a high advisory: Bad\\u000aINFO: forged line ${UA_PARSER.url}`,
      ),
      JSON.stringify(out),
    );
    assert.ok(!out.includes("INFO: forged line"));
  });

  test("the other subcommands run no audit", () => {
    const calls = (run: (env: FakeEnv) => unknown, tree: Tree): string[][] => {
      const env = fakeEnv(tree);
      run(env);
      return env.calls;
    };
    const all = [
      calls((env) => checkChangelog(env), firstReleaseTree()),
      calls((env) => checkListing(env), secondReleaseTree()),
      calls((env) => checkProtocol(env), secondReleaseTree()),
      calls((env) => checkPostRoll(env, "0.1.0"), postRollTree("first")),
      calls((env) => checkPostBump(env, "0.1.0"), postBumpTree("first")),
    ];
    for (const list of all) {
      assert.deepEqual(
        list.filter(([command]) => command === "npm"),
        [],
      );
    }
  });
});

describe("artifacts", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "foxleash-check-release-zip-")));
  after(() => rmSync(base, { recursive: true, force: true }));
  let counter = 0;

  const PAYLOAD: Record<string, string> = {
    "manifest.json": json({ manifest_version: 3, version: "1.0.0" }),
    "background.js": "console.log(1);\n",
    "icons/foxleash.svg": "<svg/>\n",
  };
  const SIGNATURE: Record<string, string> = {
    "META-INF/mozilla.rsa": "rsa",
    "META-INF/mozilla.sf": "sf",
    "META-INF/manifest.mf": "mf",
  };

  function zipInto(file: string, entries: Record<string, string>, directories = true): void {
    const staging = path.join(base, `staging-${counter++}`);
    for (const [name, content] of Object.entries(entries)) {
      mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
      writeFileSync(path.join(staging, name), content);
    }
    mkdirSync(path.dirname(file), { recursive: true });
    execFileSync("zip", [directories ? "-rqX" : "-rqXD", file, "."], { cwd: staging });
  }

  function release(
    unsigned: Record<string, string> = PAYLOAD,
    signed: Record<string, string> = { ...PAYLOAD, ...SIGNATURE },
    directories: [boolean, boolean] = [true, true],
  ): string {
    const root = path.join(base, `root-${counter++}`);
    zipInto(path.join(root, "artifacts/foxleash-1.0.0.xpi"), unsigned, directories[0]);
    zipInto(path.join(root, "web-ext-artifacts/foxleash-1.0.0.xpi"), signed, directories[1]);
    return root;
  }

  function recording(root: string): FakeEnv {
    const env = realEnv(root);
    const calls: string[][] = [];
    return {
      ...env,
      calls,
      sh(command, args) {
        calls.push([command, ...args]);
        return env.sh(command, args);
      },
      shBytes(command, args) {
        calls.push([command, ...args]);
        return env.shBytes(command, args);
      },
    };
  }

  test("a signed copy passes and prints the hash table", () => {
    const findings = checkArtifacts(realEnv(release()), "1.0.0", undefined);
    assertClean(findings);
    const table = texts(findings, "INFO");
    assert.equal(table[0], "entry | unsigned | signed");
    assert.deepEqual(
      table.slice(1).map((line) => line.split(" | ")[0]),
      ["background.js", "icons/foxleash.svg", "manifest.json"],
    );
    for (const line of table.slice(1)) {
      const [, unsigned, signed] = line.split(" | ");
      assert.match(unsigned ?? "", /^[0-9a-f]{12}$/);
      assert.equal(unsigned, signed);
    }
  });

  for (const directories of [
    [true, false],
    [false, true],
    [false, false],
  ] as [boolean, boolean][]) {
    test(`passes with directory entries ${JSON.stringify(directories)}`, () => {
      assertClean(
        checkArtifacts(realEnv(release(PAYLOAD, undefined, directories)), "1.0.0", undefined),
      );
    });
  }

  test("passes a signed manifest.json that differs only in its JSON formatting", () => {
    const manifest = PAYLOAD["manifest.json"] ?? "";
    const findings = checkArtifacts(
      realEnv(release(PAYLOAD, { ...PAYLOAD, ...SIGNATURE, "manifest.json": manifest.trimEnd() })),
      "1.0.0",
      undefined,
    );
    assertClean(findings);
    assert.ok(
      texts(findings, "INFO").includes("manifest.json differs only in its JSON formatting"),
    );
  });

  const deviations: [string, Record<string, string>, Record<string, string>, RegExp][] = [
    [
      "a missing mozilla.rsa",
      PAYLOAD,
      { ...PAYLOAD, "META-INF/mozilla.sf": "sf", "META-INF/manifest.mf": "mf" },
      /^web-ext-artifacts\/foxleash-1\.0\.0\.xpi lacks META-INF\/mozilla\.rsa$/,
    ],
    [
      "a differing entry",
      PAYLOAD,
      { ...PAYLOAD, ...SIGNATURE, "background.js": "console.log(2);\n" },
      /^background\.js differs between the unsigned and the signed XPI$/,
    ],
    [
      "an extra file entry",
      PAYLOAD,
      { ...PAYLOAD, ...SIGNATURE, "extra.js": "x" },
      /^extra\.js is in the signed XPI but not in the unsigned one$/,
    ],
    [
      "a missing file entry",
      { ...PAYLOAD, "gone.js": "x" },
      { ...PAYLOAD, ...SIGNATURE },
      /^gone\.js is in the unsigned XPI but not in the signed one$/,
    ],
    [
      "a lowercase meta-inf entry",
      PAYLOAD,
      { ...PAYLOAD, ...SIGNATURE, "meta-inf/x": "x" },
      /^meta-inf\/x is in the signed XPI but not in the unsigned one$/,
    ],
    [
      "a manifest with other content",
      PAYLOAD,
      {
        ...PAYLOAD,
        ...SIGNATURE,
        "manifest.json": json({ manifest_version: 3, version: "1.0.0", permissions: ["tabs"] }),
      },
      /^manifest\.json differs between the unsigned and the signed XPI$/,
    ],
    [
      "another manifest version",
      { ...PAYLOAD, "manifest.json": json({ version: "1.0.1" }) },
      { ...PAYLOAD, ...SIGNATURE, "manifest.json": json({ version: "1.0.1" }) },
      /^web-ext-artifacts\/foxleash-1\.0\.0\.xpi manifest\.json has version "1\.0\.1", expected 1\.0\.0$/,
    ],
  ];
  for (const [name, unsigned, signed, pattern] of deviations) {
    test(`fails on ${name}`, () => {
      assertOnlyFail(
        checkArtifacts(realEnv(release(unsigned, signed)), "1.0.0", undefined),
        pattern,
      );
    });
  }

  /** A stored zip whose entries may carry an Info-ZIP Unicode Path field (0x7075). */
  function craftedZip(file: string, entries: { name: string; data: string; shown?: string }[]) {
    const parts: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;
    for (const { name, data, shown } of entries) {
      const raw = Buffer.from(name);
      const body = Buffer.from(data);
      const extra = shown === undefined ? Buffer.alloc(0) : unicodePath(raw, shown);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(10, 4);
      local.writeUInt16LE(0x21, 12);
      local.writeUInt32LE(crc32(body), 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(body.length, 22);
      local.writeUInt16LE(raw.length, 26);
      local.writeUInt16LE(extra.length, 28);
      parts.push(local, raw, extra, body);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x031e, 4);
      central.writeUInt16LE(10, 6);
      central.writeUInt16LE(0x21, 14);
      central.writeUInt32LE(crc32(body), 16);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(body.length, 24);
      central.writeUInt16LE(raw.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt32LE(offset, 42);
      directory.push(central, raw, extra);
      offset += local.length + raw.length + extra.length + body.length;
    }
    const listing = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(listing.length, 12);
    end.writeUInt32LE(offset, 16);
    writeFileSync(file, Buffer.concat([...parts, listing, end]));
  }

  function unicodePath(raw: Buffer, shown: string): Buffer {
    const name = Buffer.from(shown);
    const header = Buffer.alloc(9);
    header.writeUInt16LE(0x7075, 0);
    header.writeUInt16LE(5 + name.length, 2);
    header.writeUInt8(1, 4);
    header.writeUInt32LE(crc32(raw), 5);
    return Buffer.concat([header, name]);
  }

  test("compares entries by their raw names, not by a Unicode Path field", () => {
    const root = release();
    craftedZip(path.join(root, "web-ext-artifacts/foxleash-1.0.0.xpi"), [
      { name: "manifest.json", data: PAYLOAD["manifest.json"] ?? "" },
      { name: "background.js", data: "evil();\n", shown: "hidden/" },
      { name: "icons/foxleash.svg", data: PAYLOAD["icons/foxleash.svg"] ?? "" },
      { name: "decoy.txt", data: PAYLOAD["background.js"] ?? "", shown: "background.js" },
      ...Object.entries(SIGNATURE).map(([name, data]) => ({ name, data })),
    ]);
    assert.deepEqual(texts(checkArtifacts(realEnv(root), "1.0.0", undefined), "FAIL"), [
      "background.js differs between the unsigned and the signed XPI",
      "decoy.txt is in the signed XPI but not in the unsigned one",
    ]);
  });

  test("an entry under _locales passes", () => {
    const locales = { ...PAYLOAD, "_locales/en/messages.json": "{}\n" };
    assertClean(
      checkArtifacts(realEnv(release(locales, { ...locales, ...SIGNATURE })), "1.0.0", undefined),
    );
  });

  test("a signed XPI without a manifest fails", () => {
    const { "manifest.json": _, ...rest } = PAYLOAD;
    const fails = texts(
      checkArtifacts(realEnv(release(rest, { ...rest, ...SIGNATURE })), "1.0.0", undefined),
      "FAIL",
    );
    assert.deepEqual(fails, ["web-ext-artifacts/foxleash-1.0.0.xpi has no manifest.json"]);
  });

  test("--unsigned is resolved against the root and used instead of the default", () => {
    const root = release();
    rmSync(path.join(root, "artifacts"), { recursive: true });
    zipInto(path.join(root, "elsewhere/plain.xpi"), PAYLOAD);
    const env = recording(root);
    assertClean(checkArtifacts(env, "1.0.0", "elsewhere/plain.xpi"));
    assert.ok(env.calls.some((call) => call.includes(path.join(root, "elsewhere/plain.xpi"))));
    assertOnlyFail(
      checkArtifacts(realEnv(root), "1.0.0", undefined),
      /^artifacts\/foxleash-1\.0\.0\.xpi does not exist$/,
    );
  });

  test("a missing signed or unsigned XPI fails without calling unzip", () => {
    for (const missing of ["web-ext-artifacts", "artifacts"]) {
      const root = release();
      rmSync(path.join(root, missing), { recursive: true });
      const env = recording(root);
      assertOnlyFail(checkArtifacts(env, "1.0.0", undefined), /does not exist$/);
      assert.deepEqual(env.calls, []);
    }
  });

  test("an --unsigned path with a wildcard character is refused without calling unzip", () => {
    const root = release();
    zipInto(path.join(root, "two.xpi"), PAYLOAD);
    writeFileSync(path.join(root, "[t]wo.xpi"), "not a zip");
    const env = recording(root);
    assertOnlyFail(
      checkArtifacts(env, "1.0.0", "[t]wo.xpi"),
      /^the archive path ".*\[t\]wo\.xpi" holds a wildcard character$/,
    );
    assert.deepEqual(env.calls, []);
  });

  for (const name of ["-x", "a*b", "q?", "[t]", ".hidden"]) {
    test(`refuses the entry name ${JSON.stringify(name)} without passing it to unzip`, () => {
      const root = release({ ...PAYLOAD, [name]: "x" }, { ...PAYLOAD, ...SIGNATURE, [name]: "x" });
      const env = recording(root);
      const fails = texts(checkArtifacts(env, "1.0.0", undefined), "FAIL");
      assert.deepEqual(fails, [
        `${path.join(root, "artifacts/foxleash-1.0.0.xpi").replace(`${root}/`, "")}: unsafe entry name ${JSON.stringify(name)}`,
        `web-ext-artifacts/foxleash-1.0.0.xpi: unsafe entry name ${JSON.stringify(name)}`,
      ]);
      assert.ok(!env.calls.some((call) => call.includes(name)));
      assert.ok(env.calls.some((call) => call.includes("background.js")));
    });
  }

  test("a duplicated entry name fails and is not hashed", () => {
    const tree: Tree = {
      files: {
        "artifacts/foxleash-1.0.0.xpi": "zip",
        "web-ext-artifacts/foxleash-1.0.0.xpi": "zip",
      },
      commands: {
        [key("unzip", "-Z1", "-UU", "artifacts/foxleash-1.0.0.xpi")]: "manifest.json\nlib.js",
        [key("unzip", "-Z1", "-UU", "web-ext-artifacts/foxleash-1.0.0.xpi")]:
          "manifest.json\nlib.js\nlib.js\nMETA-INF/mozilla.rsa\nMETA-INF/mozilla.sf\nMETA-INF/manifest.mf",
        [key("unzip", "-UU", "-p", "artifacts/foxleash-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
        [key("unzip", "-UU", "-p", "web-ext-artifacts/foxleash-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
      },
    };
    const env = fakeEnv(tree);
    const fails = texts(checkArtifacts(env, "1.0.0", undefined), "FAIL");
    assert.deepEqual(fails, [
      "web-ext-artifacts/foxleash-1.0.0.xpi: the entry lib.js is listed twice",
    ]);
    assert.ok(!env.calls.some((call) => call.includes("lib.js")));
  });

  test("an entry name with a dot or empty segment fails and is not read", () => {
    const names = ["META-INF/../evil.js", "a/./b.js", "a//c.js", "x/.."];
    const tree: Tree = {
      files: {
        "artifacts/foxleash-1.0.0.xpi": "zip",
        "web-ext-artifacts/foxleash-1.0.0.xpi": "zip",
      },
      commands: {
        [key("unzip", "-Z1", "-UU", "artifacts/foxleash-1.0.0.xpi")]: "manifest.json\nicons/",
        [key("unzip", "-Z1", "-UU", "web-ext-artifacts/foxleash-1.0.0.xpi")]: [
          "manifest.json",
          "icons/",
          ...Object.keys(SIGNATURE),
          ...names,
        ].join("\n"),
        [key("unzip", "-UU", "-p", "artifacts/foxleash-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
        [key("unzip", "-UU", "-p", "web-ext-artifacts/foxleash-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
      },
    };
    const env = fakeEnv(tree);
    assert.deepEqual(
      texts(checkArtifacts(env, "1.0.0", undefined), "FAIL"),
      names.map(
        (name) => `web-ext-artifacts/foxleash-1.0.0.xpi: unsafe entry name ${JSON.stringify(name)}`,
      ),
    );
    assert.ok(!env.calls.some((call) => names.some((name) => call.includes(name))));
  });

  test("an archive that cannot be checked fails without calling unzip", () => {
    const env: FakeEnv = {
      ...fakeEnv({ files: {}, commands: {} }),
      exists() {
        throw new Error("EACCES: permission denied");
      },
    };
    assert.deepEqual(texts(checkArtifacts(env, "1.0.0", undefined), "FAIL"), [
      "artifacts/foxleash-1.0.0.xpi: EACCES: permission denied",
      "web-ext-artifacts/foxleash-1.0.0.xpi: EACCES: permission denied",
    ]);
    assert.deepEqual(env.calls, []);
  });

  test("an unreadable entry fails and the others are still compared", () => {
    const tree: Tree = {
      files: {
        "artifacts/foxleash-1.0.0.xpi": "zip",
        "web-ext-artifacts/foxleash-1.0.0.xpi": "zip",
      },
      commands: {
        [key("unzip", "-Z1", "-UU", "artifacts/foxleash-1.0.0.xpi")]: "manifest.json\nlib.js",
        [key("unzip", "-Z1", "-UU", "web-ext-artifacts/foxleash-1.0.0.xpi")]:
          "manifest.json\nlib.js\nMETA-INF/mozilla.rsa\nMETA-INF/mozilla.sf\nMETA-INF/manifest.mf",
        [key("unzip", "-UU", "-p", "artifacts/foxleash-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
        [key("unzip", "-UU", "-p", "artifacts/foxleash-1.0.0.xpi", "lib.js")]: "a",
        [key("unzip", "-UU", "-p", "web-ext-artifacts/foxleash-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
      },
    };
    const findings = checkArtifacts(fakeEnv(tree), "1.0.0", undefined);
    assert.deepEqual(texts(findings, "FAIL"), [
      "web-ext-artifacts/foxleash-1.0.0.xpi lib.js: `unzip -UU -p web-ext-artifacts/foxleash-1.0.0.xpi lib.js` failed (status 1): not scripted in the test",
    ]);
    assert.ok(texts(findings, "INFO").some((line) => /^lib\.js \| [0-9a-f]{12} \| -$/.test(line)));
  });
});

describe("real git", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "foxleash-check-release-git-")));
  // A git hook in a linked worktree exports GIT_DIR, which would point the fixture's git
  // commands at the real repository.
  const gitVariables = Object.keys(process.env).filter((name) => name.startsWith("GIT_"));
  const saved = gitVariables.map((name) => [name, process.env[name]] as const);
  for (const name of gitVariables) Reflect.deleteProperty(process.env, name);
  after(() => {
    for (const [name, value] of saved) process.env[name] = value;
    rmSync(base, { recursive: true, force: true });
  });
  let counter = 0;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function repo(files: Record<string, string> = { "a.txt": "a\n" }): string {
    const dir = path.join(base, `repo-${counter++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    for (const [name, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"],
      ["commit.gpgsign", "false"],
      ["tag.gpgsign", "false"],
    ]) {
      git(dir, "config", name ?? "", value ?? "");
    }
    write(dir, files);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Initial");
    return dir;
  }

  function write(dir: string, files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
  }

  function commit(dir: string, message: string, files: Record<string, string>): void {
    write(dir, files);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
  }

  function withOrigin(dir: string): string {
    const bare = `${dir}.git`;
    git(base, "init", "-q", "--bare", bare);
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(dir, "fetch", "-q", "origin");
    return bare;
  }

  /** The real git, with origin's URLs as GitHub's, a green CI run for any sha, a clean audit. */
  function github(dir: string): Env {
    const env = realEnv(dir);
    return {
      ...env,
      sh(command, args) {
        if (command === "git" && args[0] === "remote" && args[1] === "get-url") return ORIGIN_URL;
        if (command === "gh") {
          return runs(ciRun({ head_sha: /head_sha=(\w+)/.exec(args.at(-1) ?? "")?.[1] }));
        }
        if (command === "npm") return json(auditReport());
        return env.sh(command, args);
      },
      listTools: () => [...FIXTURE_TOOLS],
    };
  }

  test("latestTag: none, one, the highest of several, and an unreachable tag ignored", () => {
    const dir = repo();
    const latest = (): string | null => latestTag(realEnv(dir), []);
    assert.equal(latest(), null);
    git(dir, "tag", "v0.2.0");
    assert.equal(latest(), "v0.2.0");
    git(dir, "tag", "v0.9.0");
    git(dir, "tag", "v0.10.0");
    git(dir, "config", "column.ui", "always");
    git(dir, "config", "versionsort.suffix", "0");
    assert.equal(latest(), "v0.10.0");
    git(dir, "checkout", "-q", "-b", "side");
    commit(dir, "Side", { "b.txt": "b\n" });
    git(dir, "tag", "v1.0.0");
    git(dir, "checkout", "-q", "main");
    assert.equal(latest(), "v0.10.0");
  });

  test("sh keeps the leading space of git status lines and drops one trailing newline", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    assert.equal(realEnv(dir).sh("git", ["status", "--porcelain"]), " M a.txt");
    assert.deepEqual(worktreeChanges(realEnv(dir)).status, [" M a.txt"]);
  });

  test("an untracked file and a skip-worktree change are reported despite the config", () => {
    const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
    git(dir, "config", "status.showUntrackedFiles", "no");
    writeFileSync(path.join(dir, "new.txt"), "new\n");
    git(dir, "update-index", "--skip-worktree", "b.txt");
    writeFileSync(path.join(dir, "b.txt"), "hidden\n");
    assert.deepEqual(worktreeChanges(realEnv(dir)), {
      status: ["?? new.txt"],
      hidden: ['"b.txt" is marked skip-worktree, so git status does not show its changes'],
    });
  });

  test("a failed command throws CommandError with its status and stderr", () => {
    const dir = repo();
    assert.throws(
      () => realEnv(dir).sh("git", ["rev-parse", "refs/heads/nope"]),
      (error: unknown) =>
        error instanceof CommandError &&
        error.status === 128 &&
        error.command === "git rev-parse refs/heads/nope" &&
        error.stderr.includes("unknown revision") &&
        error.name === "CommandError" &&
        error.message.startsWith("`git rev-parse refs/heads/nope` failed (status 128): "),
    );
    assert.throws(
      () => realEnv(dir).sh("foxleash-no-such-command", []),
      (error: unknown) =>
        error instanceof CommandError &&
        error.status === null &&
        /failed \(error .*ENOENT/.test(error.message),
    );
    assert.throws(
      () => realEnv(dir).sh("sh", ["-c", "kill -TERM $$"]),
      (error: unknown) =>
        error instanceof CommandError && /failed \(signal SIGTERM\)/.test(error.message),
    );
  });

  test("realEnv reads files relative to its root and checks for regular files", () => {
    const dir = repo({ "a.txt": "a\n", "sub/b.txt": "b\n" });
    const env = realEnv(dir);
    assert.equal(env.readFile("sub/b.txt"), "b\n");
    assert.equal(env.readFile(path.join(dir, "a.txt")), "a\n");
    assert.equal(env.exists("sub/b.txt"), true);
    assert.equal(env.exists("sub"), false);
    assert.equal(env.exists("missing"), false);
    assert.deepEqual(env.readdir("sub"), ["b.txt"]);
    assert.equal(env.shBytes("git", ["show", "HEAD:a.txt"]).toString(), "a\n");
    assert.match(env.today(), /^\d{4}-\d{2}-\d{2}$/);
  });

  // What releaseFiles' tree ships, listed here rather than computed by the code under test.
  const RELEASE_SHIPS = [
    "apps/extension/manifest.json",
    "apps/extension/package.json",
    "apps/extension/src/approval.ts",
    "apps/extension/src/tools.ts",
    "package-lock.json",
    "package.json",
    "packages/protocol/package.json",
    "packages/protocol/src/index.ts",
    "packages/tsconfig/package.json",
  ];

  function releaseFiles(version: string, log: string): Record<string, string> {
    return {
      ...packageFiles(version),
      ...listingFiles(),
      [PROTOCOL]: protocolSource(6, 3),
      [SOURCE_TEMPLATE]: "Node {{node}}, npm {{npm}}\n",
      [AMO_SOURCES]: `${["README.md", ...RELEASE_SHIPS].join("\n")}\n`,
      ".gitignore": "artifacts/\n",
      "CHANGELOG.md": log,
    };
  }

  test("pre-roll passes the first release against a local origin", () => {
    const dir = repo(releaseFiles("0.1.0", changelog(`## [Unreleased]\n\n${ENTRIES}`)));
    withOrigin(dir);
    const result = checkPreRoll(github(dir), undefined);
    assert.ok("findings" in result);
    assertClean(result.findings);
  });

  test("pre-roll counts commits ahead and behind origin/main", () => {
    const dir = repo(releaseFiles("0.1.0", changelog(`## [Unreleased]\n\n${ENTRIES}`)));
    withOrigin(dir);
    commit(dir, "Ahead", { "x.txt": "x\n" });
    const ahead = checkPreRoll(github(dir), undefined);
    assert.ok("findings" in ahead);
    assert.deepEqual(texts(ahead.findings, "FAIL"), [
      "HEAD is 1 commit(s) ahead of origin/main; push or reset first",
    ]);
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(dir, "reset", "-q", "--hard", "HEAD~1");
    const behind = checkPreRoll(github(dir), undefined);
    assert.ok("findings" in behind);
    assert.deepEqual(texts(behind.findings, "FAIL"), [
      "HEAD is 1 commit(s) behind origin/main; pull first",
    ]);
  });

  test("pre-roll reads origin's main even when remote.origin.fetch maps another branch onto it", () => {
    const dir = repo(releaseFiles("0.1.0", changelog(`## [Unreleased]\n\n${ENTRIES}`)));
    withOrigin(dir);
    commit(dir, "Ahead", { "x.txt": "x\n" });
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/other");
    git(
      dir,
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/other:refs/remotes/origin/main",
    );
    const result = checkPreRoll(github(dir), undefined);
    assert.ok("findings" in result);
    assert.deepEqual(texts(result.findings, "FAIL"), [
      "HEAD is 1 commit(s) ahead of origin/main; push or reset first",
    ]);
  });

  /** A repository at pre-push of 0.2.0: v0.1.0 released and pushed, the two release commits. */
  function secondRelease(): string {
    const dir = repo(
      releaseFiles("0.1.0", changelog(`## [Unreleased]\n\n${ENTRIES}`, OLD_SECTION)),
    );
    git(dir, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
    withOrigin(dir);
    git(dir, "push", "-q", "origin", "refs/tags/v0.1.0");
    git(dir, "switch", "-q", "--no-track", "-c", "release/0.2.0");
    commit(dir, "Update changelog for 0.2.0", {
      "CHANGELOG.md": changelog(
        "## [Unreleased]",
        `## [0.2.0] - ${TODAY}\n\n${ENTRIES}`,
        OLD_SECTION,
      ),
    });
    commit(dir, "Bump version to 0.2.0", packageFiles("0.2.0"));
    git(dir, "tag", "-a", "v0.2.0", "-m", "v0.2.0");
    const staging = path.join(base, `xpi-${counter++}`);
    write(staging, { "manifest.json": json({ manifest_version: 3, version: "0.2.0" }) });
    mkdirSync(path.join(dir, "artifacts"));
    execFileSync("zip", ["-rqX", path.join(dir, "artifacts/foxleash-0.2.0.xpi"), "."], {
      cwd: staging,
    });
    zipSource(dir);
    return dir;
  }

  /**
   * Zips the files the fixture's v0.2.0 ships, as the working tree holds them, and a README.md,
   * into `<dir>/artifacts`; `changes` adds or replaces entries, and drops one given null.
   */
  function zipSource(dir: string, changes: Record<string, string | null> = {}): void {
    const staging = path.join(base, `source-${counter++}`);
    for (const file of RELEASE_SHIPS) {
      mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
      copyFileSync(path.join(dir, file), path.join(staging, file));
    }
    writeFileSync(path.join(staging, "README.md"), "Node 24.11.0, npm 11.6.2\n");
    for (const [file, content] of Object.entries(changes)) {
      if (content === null) {
        rmSync(path.join(staging, file));
      } else {
        mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
        writeFileSync(path.join(staging, file), content);
      }
    }
    const archive = path.join(dir, SOURCE_ZIP);
    // zip would update an existing archive in place.
    rmSync(archive, { force: true });
    execFileSync("zip", ["-rqXy", archive, "."], { cwd: staging });
  }

  test("pre-push passes a second release against a local origin", () => {
    assertClean(checkPrePush(github(secondRelease())));
  });

  test("pre-push fails on a source archive built from an edit that is no longer there", () => {
    const dir = secondRelease();
    const file = path.join(dir, "apps/extension/src/tools.ts");
    const saved = readFileSync(file);
    writeFileSync(file, "export const exfiltrate = true;\n");
    zipSource(dir);
    writeFileSync(file, saved);
    assert.equal(git(dir, "status", "--porcelain", "--untracked-files=all"), "");
    assertOnlyFail(
      checkPrePush(github(dir)),
      /^artifacts\/foxleash-source-0\.2\.0\.zip: apps\/extension\/src\/tools\.ts differs from v0\.2\.0 \([0-9a-f]{12}\)$/,
    );
  });

  test("pre-push fails on a source archive that lacks a shipped file", () => {
    const dir = secondRelease();
    zipSource(dir, { "apps/extension/src/approval.ts": null });
    assertOnlyFail(
      checkPrePush(github(dir)),
      /^artifacts\/foxleash-source-0\.2\.0\.zip lacks apps\/extension\/src\/approval\.ts, which v0\.2\.0 \([0-9a-f]{12}\) ships$/,
    );
  });

  test("pre-push fails on each source archive entry the tag does not ship", () => {
    const dir = secondRelease();
    zipSource(dir, {
      "apps/extension/src/extra.ts": "extra();\n",
      "CHANGELOG.md": "# Changelog\n",
    });
    const at = `v0.2.0 (${git(dir, "rev-parse", "HEAD").slice(0, 12)})`;
    assert.deepEqual(texts(checkPrePush(github(dir)), "FAIL"), [
      `${SOURCE_ZIP}: CHANGELOG.md is not a file ${at} ships`,
      `${SOURCE_ZIP}: apps/extension/src/extra.ts is not a file ${at} ships`,
    ]);
  });

  test("pre-push takes any versions in the README.md, and nothing else", () => {
    const dir = secondRelease();
    zipSource(dir, { "README.md": "Node 26.0.1, npm 12.10.0\n" });
    assertClean(checkPrePush(github(dir)));
    zipSource(dir, {
      "README.md": "Node 26.0.1, npm 12.10.0\nRun npm ci --ignore-scripts=false.\n",
    });
    assertOnlyFail(
      checkPrePush(github(dir)),
      /^artifacts\/foxleash-source-0\.2\.0\.zip: README\.md is not the README of v0\.2\.0 \([0-9a-f]{12}\) with a Node and an npm version filled in$/,
    );
    zipSource(dir, { "README.md": null });
    assertOnlyFail(
      checkPrePush(github(dir)),
      /^artifacts\/foxleash-source-0\.2\.0\.zip lacks README\.md$/,
    );
  });

  test("built checks the artifacts in artifacts/ or in --dir against the tag", () => {
    const dir = secondRelease();
    assertClean(checkBuilt(realEnv(dir), "0.2.0", undefined));
    const elsewhere = path.join(base, `elsewhere-${counter++}`);
    renameSync(path.join(dir, "artifacts"), elsewhere);
    const env = realEnv(dir);
    assertClean(checkBuilt(env, "0.2.0", elsewhere));
    assertClean(checkBuilt(env, "0.2.0", path.relative(dir, elsewhere)));
    assert.deepEqual(texts(checkBuilt(env, "0.2.0", undefined), "FAIL"), [
      "artifacts/foxleash-source-0.2.0.zip is missing; run npm run build:amo",
      "artifacts/foxleash-0.2.0.xpi is missing; run npm run build:amo",
    ]);
  });

  test("built fails when the tag does not exist", () => {
    const dir = secondRelease();
    const out: string[] = [];
    const io = {
      out: (line: string) => out.push(line),
      err: () => assert.fail("printed to stderr"),
    };
    assert.equal(runCli(["built", "0.2.0"], realEnv(dir), io), 0);
    assert.equal(out.at(-1), "check-release: built ok");
    git(dir, "tag", "-d", "v0.2.0");
    assertOnlyFail(
      checkBuilt(realEnv(dir), "0.2.0", undefined),
      /^artifacts\/foxleash-source-0\.2\.0\.zip: `git rev-parse refs\/tags\/v0\.2\.0\^\{commit\}` failed/,
    );
    assert.equal(runCli(["built", "0.2.0"], realEnv(dir), io), 1);
    assert.equal(out.at(-1), "check-release: built failed");
  });

  test("built fails when the tag's list ships a file the ship rules of the checkout do not", () => {
    // The tag's own rules shipped a.test.ts; an archive built by newer rules lacks it.
    const dir = secondRelease();
    commit(dir, "Ship a test file", {
      "apps/extension/src/a.test.ts": "test();\n",
      [AMO_SOURCES]: `${["README.md", ...RELEASE_SHIPS, "apps/extension/src/a.test.ts"].join("\n")}\n`,
    });
    git(dir, "tag", "-f", "-a", "v0.2.0", "-m", "v0.2.0");
    assertOnlyFail(
      checkBuilt(realEnv(dir), "0.2.0", undefined),
      /^bin\/amo-source-files\.txt at v0\.2\.0 \([0-9a-f]{12}\) lists apps\/extension\/src\/a\.test\.ts, which the ship rules of this checkout do not ship$/,
    );
  });

  test("pre-push fails when the release commits are on main", () => {
    const dir = secondRelease();
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--ff-only", "release/0.2.0");
    const fails = texts(checkPrePush(github(dir)), "FAIL");
    assert.equal(fails.length, 2, JSON.stringify(fails));
    assert.ok(fails.includes('on branch "main", not release/0.2.0'), JSON.stringify(fails));
    assert.ok(
      fails.some((text) => text.startsWith("local main has commits that origin/main does not: ")),
      JSON.stringify(fails),
    );
  });

  test("pre-push fails when local main also holds the release commits", () => {
    const dir = secondRelease();
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--ff-only", "release/0.2.0");
    git(dir, "checkout", "-q", "release/0.2.0");
    const ahead = git(dir, "rev-list", "refs/remotes/origin/main..refs/heads/main");
    assertOnlyFail(
      checkPrePush(github(dir)),
      new RegExp(
        `^local main has commits that origin/main does not: ${ahead.split("\n").join(", ")}$`,
      ),
    );
  });

  test("pre-push fails on a lightweight tag", () => {
    const dir = secondRelease();
    git(dir, "tag", "-d", "v0.2.0");
    git(dir, "tag", "v0.2.0");
    assertOnlyFail(checkPrePush(github(dir)), /^the tag v0\.2\.0 is not annotated/);
  });

  test("pre-push fails when the tag is already on origin", () => {
    const dir = secondRelease();
    git(dir, "push", "-q", "origin", "refs/tags/v0.2.0");
    assertOnlyFail(checkPrePush(github(dir)), /^the tag v0\.2\.0 is already on origin$/);
  });

  test("pre-push fails when HEAD does not descend from origin/main", () => {
    const dir = secondRelease();
    git(dir, "checkout", "-q", "-b", "side", "HEAD~2");
    commit(dir, "Elsewhere", { "x.txt": "x\n" });
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(dir, "checkout", "-q", "release/0.2.0");
    const fails = texts(checkPrePush(github(dir)), "FAIL");
    assert.ok(
      fails.includes("HEAD does not descend from origin/main; rebase on it first"),
      JSON.stringify(fails),
    );
  });

  test("pre-push fails on a merge commit in the range", () => {
    const dir = secondRelease();
    git(dir, "checkout", "-q", "-b", "side", "HEAD~2");
    commit(dir, "Side", { "x.txt": "x\n" });
    git(dir, "checkout", "-q", "release/0.2.0");
    git(dir, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
    git(dir, "tag", "-d", "v0.2.0");
    git(dir, "tag", "-a", "v0.2.0", "-m", "v0.2.0");
    assertFail(
      checkPrePush(github(dir)),
      /^the commits on top of origin\/main include merges: [0-9a-f]{40}$/,
    );
  });

  test("pre-push sees the commits a push sends, whatever replace refs say", () => {
    const dir = secondRelease();
    writeFileSync(path.join(dir, "evil.js"), "evil();\n");
    git(dir, "add", "evil.js");
    git(dir, "commit", "-q", "--amend", "--no-edit");
    git(dir, "tag", "-f", "-a", "v0.2.0", "-m", "v0.2.0");
    git(dir, "rm", "-q", "--cached", "evil.js");
    rmSync(path.join(dir, "evil.js"));
    const tree = git(dir, "write-tree");
    const fake = git(dir, "commit-tree", tree, "-p", "HEAD~1", "-m", "Bump version to 0.2.0");
    git(dir, "replace", git(dir, "rev-parse", "HEAD"), fake);
    assertFail(checkPrePush(github(dir)), /evil\.js/);
  });

  test("pre-push keeps the new tag whatever the fetch configuration", () => {
    const dir = secondRelease();
    git(dir, "config", "fetch.prune", "true");
    git(dir, "config", "fetch.pruneTags", "true");
    git(dir, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
    assertClean(checkPrePush(github(dir)));
    assert.equal(git(dir, "tag", "--list", "v0.2.0"), "v0.2.0");
  });

  /** A repository holding the listing fixture, tagged v0.1.0. */
  function listingRepo(): string {
    const dir = repo({
      ...listingFiles(),
      [MANIFEST]: json(FIXTURE_MANIFEST),
      [AMO_SOURCES]: "apps/extension/manifest.json\n",
    });
    git(dir, "tag", "v0.1.0");
    return dir;
  }

  function listingAt(dir: string): Finding[] {
    return checkListing({ ...realEnv(dir), listTools: () => [...FIXTURE_TOOLS] });
  }

  function driftFail(keys: string): string {
    return `the manifest's ${keys} changed since v0.1.0, but docs/amo/listing.md did not: update the listing to match`;
  }

  const withoutStorage = {
    [MANIFEST]: json({ ...FIXTURE_MANIFEST, permissions: ["tabs"] }),
  };
  const storageBullet = "- storage: keeps the settings.\n";

  test("drift: a permissions change without a listing change fails and prints the diffs", () => {
    const dir = listingRepo();
    commit(dir, "Drop storage", withoutStorage);
    const findings = listingAt(dir);
    assert.deepEqual(texts(findings, "FAIL"), [
      'docs/amo/listing.md line 30 explains the permission "storage", which the manifest does not request',
      driftFail("permissions"),
    ]);
    const lines = texts(findings, "INFO");
    assert.equal(lines[0], "manifest since v0.1.0:");
    assert.ok(lines.includes('-    "storage"'), JSON.stringify(lines));
    assert.ok(lines.includes('-    "tabs",') && lines.includes('+    "tabs"'));
    assert.ok(lines.includes("listing since v0.1.0: no change"));
    assert.equal(lines.at(-1), "AMO source files since v0.1.0: no change");
  });

  test("drift: a permissions change with its listing change passes and shows both diffs", () => {
    const dir = listingRepo();
    commit(dir, "Drop storage", {
      ...withoutStorage,
      [LISTING]: FIXTURE_LISTING.replace(storageBullet, ""),
    });
    const findings = listingAt(dir);
    assertClean(findings);
    const lines = texts(findings, "INFO");
    assert.ok(lines.includes("manifest since v0.1.0:"));
    assert.ok(lines.includes("listing since v0.1.0:"));
    assert.ok(lines.includes(`-${storageBullet.trim()}`), JSON.stringify(lines));
    assert.ok(lines.includes('-    "storage"'));
  });

  test("drift: a ref that shadows the tag's name is not read", () => {
    const dir = listingRepo();
    commit(dir, "Drop storage", withoutStorage);
    git(dir, "update-ref", "refs/v0.1.0", "HEAD");
    assert.deepEqual(texts(listingAt(dir), "FAIL"), [
      'docs/amo/listing.md line 30 explains the permission "storage", which the manifest does not request',
      driftFail("permissions"),
    ]);
  });

  test("drift: compares the tag with the working tree, not with HEAD", () => {
    const dir = listingRepo();
    write(dir, { ...withoutStorage, [LISTING]: FIXTURE_LISTING.replace(storageBullet, "") });
    const findings = listingAt(dir);
    assertClean(findings);
    assert.ok(texts(findings, "INFO").includes(`-${storageBullet.trim()}`));
    assert.ok(texts(findings, "INFO").includes('-    "storage"'));
    write(dir, { [LISTING]: FIXTURE_LISTING });
    assert.deepEqual(texts(listingAt(dir), "FAIL"), [
      'docs/amo/listing.md line 30 explains the permission "storage", which the manifest does not request',
      driftFail("permissions"),
    ]);
  });

  test("drift: a diff driver or textconv in the config does not change the diff", () => {
    const dir = listingRepo();
    git(dir, "config", "diff.hide.textconv", "true");
    git(dir, "config", "diff.external", "true");
    write(dir, { ".git/info/attributes": "*.json diff=hide\n" });
    commit(dir, "Drop storage", withoutStorage);
    assert.ok(texts(listingAt(dir), "INFO").includes('-    "storage"'));
  });

  const driftCases: [string, Record<string, unknown>][] = [
    ["host_permissions", { host_permissions: ["<all_urls>", "tabs"] }],
    ["optional_host_permissions", { optional_host_permissions: ["<all_urls>"] }],
    ["content_scripts matches", { content_scripts: [{ js: ["a.js"], matches: ["<all_urls>"] }] }],
    [
      "data_collection_permissions",
      {
        browser_specific_settings: {
          gecko: {
            data_collection_permissions: { required: ["websiteContent", "browsingActivity"] },
          },
        },
      },
    ],
  ];
  for (const [name, change] of driftCases) {
    test(`drift: a change of ${name} counts`, () => {
      const dir = listingRepo();
      commit(dir, "Change", { [MANIFEST]: json({ ...FIXTURE_MANIFEST, ...change }) });
      const findings = listingAt(dir);
      assert.deepEqual(texts(findings, "FAIL"), [driftFail(name)]);
      assert.ok(texts(findings, "INFO").some((line) => /^\+ /.test(line)));
      assert.ok(texts(findings, "INFO").includes("listing since v0.1.0: no change"));
      assert.ok(texts(findings, "INFO").includes("AMO source files since v0.1.0: no change"));
      commit(dir, "Explain", { [LISTING]: `${FIXTURE_LISTING}\nThe change is explained.\n` });
      const explained = listingAt(dir);
      assertClean(explained);
      assert.ok(texts(explained, "INFO").includes("+The change is explained."));
    });
  }

  test("drift: an absent key and an empty value are no change", () => {
    const dir = listingRepo();
    commit(dir, "Empty", {
      [MANIFEST]: json({
        ...FIXTURE_MANIFEST,
        optional_permissions: [],
        optional_host_permissions: [],
        content_scripts: [],
        browser_specific_settings: {
          gecko: {
            data_collection_permissions: { required: ["websiteContent"], optional: [] },
          },
        },
      }),
      [AMO_SOURCES]: "apps/extension/manifest.json\napps/extension/src/a.ts\n",
    });
    const findings = listingAt(dir);
    assertClean(findings);
    assert.ok(texts(findings, "INFO").includes("+apps/extension/src/a.ts"));
    commit(dir, "Scripts", {
      [MANIFEST]: json({ ...FIXTURE_MANIFEST, content_scripts: [{ js: ["a.js"] }] }),
    });
    assert.deepEqual(texts(listingAt(dir), "FAIL"), [driftFail("content_scripts matches")]);
  });

  test("a committed symlink is not evidence", () => {
    const dir = listingRepo();
    symlinkSync("tools.ts", path.join(dir, "apps/extension/src/link.ts"));
    const claims = structuredClone(FIXTURE_CLAIMS);
    claims.safeguards[0]?.evidence.push({
      file: "apps/extension/src/link.ts",
      contains: "untrusted",
    });
    commit(dir, "Link", { [CLAIMS]: json(claims) });
    assert.deepEqual(texts(listingAt(dir), "FAIL"), [
      'safeguard "The approval can only come from your click": apps/extension/src/link.ts is not a tracked regular file',
    ]);
  });

  test("the real listTools returns the tools the server registers", () => {
    const tools = realEnv(path.resolve(import.meta.dirname, "..")).listTools();
    assert.ok(Array.isArray(tools) && tools.every((name) => typeof name === "string"));
    for (const name of ["tabs_list", "tab_open", "navigate"]) assert.ok(tools.includes(name));
  });

  test("listTools refuses output that is not a JSON array of strings", () => {
    const dir = repo();
    const tools = (body: string): string[] => {
      write(dir, { "apps/server/src/tools.ts": body });
      return realEnv(dir).listTools();
    };
    assert.deepEqual(
      tools("export function registerTools(server) { server.registerTool('a'); }\n"),
      ["a"],
    );
    assert.throws(
      () => tools("export function registerTools(server) { server.registerTool(7); }\n"),
      { message: 'the tool list is not a JSON array of strings: "[7]"' },
    );
    assert.throws(
      () =>
        tools(
          "export function registerTools() { process.stdout.write('x'.repeat(300)); process.exit(0); }\n",
        ),
      { message: `the tool list is not a JSON array of strings: "${"x".repeat(200)}..."` },
    );
    assert.throws(
      () =>
        tools('export function registerTools() { process.stdout.write("{}"); process.exit(0); }\n'),
      {
        message: 'the tool list is not a JSON array of strings: "{}"',
      },
    );
    assert.throws(
      () =>
        tools(
          "export function registerTools() { process.stdout.write('y'.repeat(200)); process.exit(0); }\n",
        ),
      { message: `the tool list is not a JSON array of strings: "${"y".repeat(200)}"` },
    );
    assert.throws(() => tools("export const nothing = 1;\n"), CommandError);
  });
});

describe("runCli", () => {
  function cli(tree: Tree, ...argv: string[]): { status: number; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const status = runCli(argv, fakeEnv(tree), {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { status, out, err };
  }

  test("exit 0 with the findings and the ok line", () => {
    const { status, out, err } = cli(firstReleaseTree(), "pre-roll");
    assert.equal(status, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out.slice(-6), [
      "INFO: no previous tag: drift check skipped",
      "INFO: no previous tag: protocol check against a release skipped",
      "INFO: protocol 6, oldest served 3",
      "INFO: no previous tag: first release",
      "INFO: next version: 0.1.0",
      "check-release: pre-roll ok",
    ]);
  });

  test("exit 1 on a FAIL", () => {
    const { status, out } = cli(firstReleaseTree(), "pre-roll", "--bump=minor");
    assert.equal(status, 1);
    assert.ok(out.includes("FAIL: the first release is the current version 0.1.0; omit --bump"));
    assert.equal(out.at(-1), "check-release: pre-roll failed");
  });

  test("exit 3 on a WARNING with no FAIL", () => {
    const tree = secondReleaseTree();
    Object.assign(tree.commands, { [tagList("v1.0.0")]: "", [lsRemote("v1.0.0")]: "" });
    const { status, out } = cli(tree, "pre-roll", "--bump=major");
    assert.equal(status, 3);
    assert.ok(
      out.includes(
        "WARNING: --bump=major is bigger than the minor bump the Unreleased changes need",
      ),
    );
    assert.equal(out.at(-1), "check-release: pre-roll needs confirmation");
  });

  test("exit 2 with the usage block when --bump is missing after a tag", () => {
    const { status, out, err } = cli(secondReleaseTree(), "pre-roll");
    assert.equal(status, 2);
    assert.deepEqual(out, []);
    assert.equal(err[0], "check-release: --bump is required: the previous release is v0.1.0");
    assert.equal(err[1], "usage: npm run check:release -- <subcommand>");
  });

  test("changelog checks only the shape", () => {
    const tree: Tree = { files: { "CHANGELOG.md": "## [Unreleased]\n" }, commands: {} };
    assert.deepEqual(cli(tree, "changelog"), {
      status: 0,
      out: ["check-release: changelog ok"],
      err: [],
    });
    tree.files["CHANGELOG.md"] = "## [Unreleased]\nstray\n";
    const { status, out } = cli(tree, "changelog");
    assert.equal(status, 1);
    assert.deepEqual(out, [
      'FAIL: CHANGELOG.md:2: not a section header, change type heading, entry or continuation line: "stray"',
      "check-release: changelog failed",
    ]);
  });

  test("listing prints its findings and the verdict", () => {
    assert.deepEqual(cli(firstReleaseTree(), "listing"), {
      status: 0,
      out: ["INFO: no previous tag: drift check skipped", "check-release: listing ok"],
      err: [],
    });
    const tree = firstReleaseTree();
    tree.tools = ["navigate", "read_page"];
    const { status, out } = cli(tree, "listing");
    assert.equal(status, 1);
    assert.equal(out.at(-1), "check-release: listing failed");
  });

  test("each finding prints as one line, whatever it holds", () => {
    const tree: Tree = {
      files: {
        "CHANGELOG.md": "## [Unreleased]\nx\rcheck-release: changelog ok\n\u001b[2Ky\n",
      },
      commands: {},
    };
    const { out } = cli(tree, "changelog");
    assert.deepEqual(out, [
      'FAIL: CHANGELOG.md:2: a carriage return inside the line: "x\\rcheck-release: changelog ok"',
      'FAIL: CHANGELOG.md:2: not a section header, change type heading, entry or continuation line: "x\\rcheck-release: changelog ok"',
      'FAIL: CHANGELOG.md:3: not a section header, change type heading, entry or continuation line: "\\u001b[2Ky"',
      "check-release: changelog failed",
    ]);
    const thrown: Tree = {
      files: { ...postRollTree("first").files },
      commands: {
        ...postRollTree("first").commands,
        [SHOW_CHANGELOG]: new CommandError(
          "git show",
          128,
          "fatal: one\ncheck-release: post-roll ok\n",
        ),
      },
    };
    const result = cli(thrown, "post-roll", "0.1.0");
    assert.ok(
      result.out.includes(
        "FAIL: CHANGELOG.md at HEAD: `git show` failed (status 128): fatal: one\\u000acheck-release: post-roll ok",
      ),
      JSON.stringify(result.out),
    );
    assert.equal(result.out.filter((line) => line.startsWith("check-release:")).length, 1);
    assert.equal(result.out.at(-1), "check-release: post-roll failed");
  });

  const usage: [string[], string][] = [
    [[], "no subcommand given"],
    [["bogus"], 'unknown subcommand "bogus"'],
    [["post-roll"], "post-roll needs a <version>"],
    [["post-roll", "1.2"], 'malformed version "1.2": expected x.y.z'],
    [["post-bump", "01.2.3"], 'malformed version "01.2.3": expected x.y.z'],
    [["artifacts", "1.2.3", "4.5.6"], 'unexpected argument "4.5.6"'],
    [["pre-roll", "--bump=huge"], '--bump must be patch, minor or major, not "huge"'],
    [["pre-roll", "--bump=minor", "--bump=minor"], "--bump is given twice"],
    [["pre-roll", "--bump", "minor"], 'unknown option "--bump" for pre-roll'],
    [["pre-push", "--bump=minor"], 'unknown option "--bump=minor" for pre-push'],
    [["pre-push", "extra"], 'unexpected argument "extra"'],
    [["listing", "extra"], 'unexpected argument "extra"'],
    [["listing", "--bump=minor"], 'unknown option "--bump=minor" for listing'],
    [["protocol", "extra"], 'unexpected argument "extra"'],
    [["protocol", "--bump=minor"], 'unknown option "--bump=minor" for protocol'],
    [["--help"], 'unknown subcommand "--help"'],
    [["changelog", "--verbose"], 'unknown option "--verbose" for changelog'],
    [["artifacts", "1.0.0", "--unsigned"], "--unsigned needs a path"],
    [["artifacts", "1.0.0", "--unsigned", ""], "--unsigned needs a path"],
    [["artifacts", "1.0.0", "--unsigned", "a", "--unsigned", "b"], "--unsigned is given twice"],
    [["post-roll", "1.0.0", "--unsigned", "a"], 'unknown option "--unsigned" for post-roll'],
    [["built"], "built needs a <version>"],
    [["built", "1.0"], 'malformed version "1.0": expected x.y.z'],
    [["built", "1.0.0", "2.0.0"], 'unexpected argument "2.0.0"'],
    [["built", "1.0.0", "--dir"], "--dir needs a path"],
    [["built", "1.0.0", "--dir", ""], "--dir needs a path"],
    [["built", "1.0.0", "--dir", "a", "--dir", "b"], "--dir is given twice"],
    [["built", "1.0.0", "--unsigned", "a"], 'unknown option "--unsigned" for built'],
    [["pre-push", "--dir", "a"], 'unknown option "--dir" for pre-push'],
    [["artifacts", "1.0.0", "--dir", "a"], 'unknown option "--dir" for artifacts'],
    [["bogus\u001b[2K"], 'unknown subcommand "bogus\\u001b[2K"'],
  ];
  for (const [argv, problem] of usage) {
    test(`usage error: ${JSON.stringify(argv)}`, () => {
      const env = fakeEnv(firstReleaseTree());
      const err: string[] = [];
      const status = runCli(argv, env, {
        out: () => assert.fail("printed to stdout"),
        err: (line) => err.push(line),
      });
      assert.equal(status, 2);
      assert.equal(err[0], `check-release: ${problem}`);
      assert.ok(err.includes("usage: npm run check:release -- <subcommand>"));
      assert.deepEqual(env.calls, []);
    });
  }

  test("the usage lists every subcommand, for an unknown one and for --help", () => {
    const subcommands = [
      "changelog",
      "listing",
      "protocol",
      "pre-roll",
      "post-roll",
      "post-bump",
      "pre-push",
      "built",
      "artifacts",
    ];
    for (const argv of [["bogus"], ["--help"]]) {
      const err: string[] = [];
      runCli(argv, fakeEnv(firstReleaseTree()), { out: () => {}, err: (line) => err.push(line) });
      for (const name of subcommands) {
        assert.ok(
          err.some((line) => line.startsWith(`  ${name} `)),
          `${JSON.stringify(argv)} prints no usage line for ${name}`,
        );
      }
      assert.ok(
        err.includes(
          "  protocol                                 the extension serves the latest release's server",
        ),
      );
      assert.ok(
        err.includes(
          "  built <version> [--dir <path>]           the source archive is the tagged commit's, the XPI has <version>",
        ),
      );
    }
  });

  test("a protocol run prints its findings and the verdict", () => {
    const tree = firstReleaseTree();
    assert.deepEqual(cli(tree, "protocol"), {
      status: 0,
      out: [
        "INFO: no previous tag: protocol check against a release skipped",
        "INFO: protocol 6, oldest served 3",
        "check-release: protocol ok",
      ],
      err: [],
    });
    tree.files[PROTOCOL] = protocolSource(6, 7);
    const { status, out } = cli(tree, "protocol");
    assert.equal(status, 1);
    assert.equal(out[0], "FAIL: OLDEST_SERVED_PROTOCOL 7 is above PROTOCOL_VERSION 6");
    assert.equal(out.at(-1), "check-release: protocol failed");
  });

  test("parseArgs builds each command", () => {
    assert.deepEqual(parseArgs(["changelog"]), { name: "changelog" });
    assert.deepEqual(parseArgs(["pre-roll"]), { name: "pre-roll", bump: undefined });
    assert.deepEqual(parseArgs(["pre-roll", "--bump=patch"]), { name: "pre-roll", bump: "patch" });
    assert.deepEqual(parseArgs(["post-roll", "0.2.0"]), { name: "post-roll", version: "0.2.0" });
    assert.deepEqual(parseArgs(["post-bump", "0.2.0"]), { name: "post-bump", version: "0.2.0" });
    assert.deepEqual(parseArgs(["pre-push"]), { name: "pre-push" });
    assert.deepEqual(parseArgs(["built", "1.0.0"]), {
      name: "built",
      version: "1.0.0",
      dir: undefined,
    });
    assert.deepEqual(parseArgs(["built", "--dir", "x", "1.0.0"]), {
      name: "built",
      version: "1.0.0",
      dir: "x",
    });
    assert.deepEqual(parseArgs(["listing"]), { name: "listing" });
    assert.deepEqual(parseArgs(["protocol"]), { name: "protocol" });
    assert.deepEqual(parseArgs(["artifacts", "1.0.0", "--unsigned", "x.xpi"]), {
      name: "artifacts",
      version: "1.0.0",
      unsigned: "x.xpi",
    });
    assert.deepEqual(parseArgs(["artifacts", "--unsigned", "-x.xpi", "1.0.0"]), {
      name: "artifacts",
      version: "1.0.0",
      unsigned: "-x.xpi",
    });
  });

  test("the script runs the CLI when started directly", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "check-release.ts"), "bogus"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^check-release: unknown subcommand "bogus"\nusage: npm run check:release/,
    );
  });
});

describe("helpers", () => {
  test("escapeControls escapes line breaks, controls, separators and bidi controls", () => {
    assert.equal(
      escapeControls(
        "a\nb\r\u0000\u001b\u007f\u0085\u009f\u2028\u2029\u202a\u202e\u2066\u2069\u061c\u200e\u200fé😀 z",
      ),
      "a\\u000ab\\u000d\\u0000\\u001b\\u007f\\u0085\\u009f\\u2028\\u2029\\u202a\\u202e\\u2066\\u2069\\u061c\\u200e\\u200fé😀 z",
    );
    assert.equal(
      escapeControls("\u001f ~\u00a0\u2027\u202f\u2065\u206a\u061b\u061d\u200d\u2010"),
      "\\u001f ~\u00a0\u2027\u202f\u2065\u206a\u061b\u061d\u200d\u2010",
    );
  });

  test("parseSlug accepts the three GitHub URL forms only", () => {
    for (const url of [
      "git@github.com:owner/repo.git",
      "git@github.com:owner/repo",
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo",
      "ssh://git@github.com/owner/repo.git",
    ]) {
      assert.equal(parseSlug(url), "owner/repo", url);
    }
    assert.equal(parseSlug("https://github.com/my-org/my.repo_1.git"), "my-org/my.repo_1");
    for (const url of [
      "https://gitlab.com/owner/repo.git",
      "https://github.com:443/owner/repo.git",
      "https://user:token@github.com/owner/repo.git",
      "https://github.com/owner/repo/",
      "https://github.com/owner/sub/repo",
      "https://github.com/../..",
      "https://github.com/./repo",
      "https://github.com/owner/a%2Fb",
      "http://github.com/owner/repo",
      " https://github.com/owner/repo",
    ]) {
      assert.equal(parseSlug(url), undefined, url);
    }
  });

  test("mainCiRuns keeps only this repository's ci.yml runs on main for HEAD", () => {
    assert.deepEqual(
      mainCiRuns(
        { workflow_runs: [ciRun({ head_repository: { full_name: "Owner/Repo" } })] },
        "owner/repo",
        HEAD,
      ),
      [
        {
          id: 101,
          event: "push",
          status: "completed",
          conclusion: "success",
          started: Date.parse("2026-10-18T10:00:00Z"),
        },
      ],
    );
    assert.equal(typeof mainCiRuns(null, "owner/repo", HEAD), "string");
    assert.equal(typeof mainCiRuns({ workflow_runs: [1] }, "owner/repo", HEAD), "string");
    for (const bad of [
      { id: "101" },
      { id: 1.5 },
      { event: 7 },
      { event: "push\nx" },
      { status: null },
      { status: "Completed" },
      { conclusion: 1 },
      { conclusion: "success!" },
      { run_started_at: 7 },
    ]) {
      assert.equal(
        typeof mainCiRuns({ workflow_runs: [ciRun(bad)] }, "owner/repo", HEAD),
        "string",
        JSON.stringify(bad),
      );
    }
  });

  test("localDate uses the local time zone", () => {
    const saved = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      assert.equal(localDate(new Date(Date.UTC(2026, 11, 31, 12))), "2027-01-01");
      process.env.TZ = "Pacific/Pago_Pago";
      assert.equal(localDate(new Date(Date.UTC(2026, 0, 1, 5))), "2025-12-31");
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env.TZ = saved;
    }
  });

  test("checkChangelog reports a missing file", () => {
    assert.deepEqual(checkChangelog(fakeEnv({ files: {}, commands: {} })), [
      { level: "FAIL", text: "CHANGELOG.md: ENOENT: CHANGELOG.md" },
    ]);
  });
});
