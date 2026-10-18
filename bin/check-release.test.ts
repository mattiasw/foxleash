import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { crc32 } from "node:zlib";
import {
  type Bump,
  breakingChangeEntries,
  CommandError,
  checkArtifacts,
  checkChangelog,
  checkPostBump,
  checkPostRoll,
  checkPrePush,
  checkPreRoll,
  compareVersions,
  type Env,
  escapeControls,
  type Finding,
  latestTag,
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
const SHOW_CHANGELOG = key("git", "show", "HEAD:CHANGELOG.md");
const SHOW_PACKAGE = key("git", "show", "HEAD:package.json");
const SHOW_ORIGIN_PACKAGE = key("git", "show", "refs/remotes/origin/main:package.json");
const ANCESTOR = key("git", "merge-base", "--is-ancestor", "refs/remotes/origin/main", "HEAD");
const MERGES = key("git", "rev-list", "--merges", "refs/remotes/origin/main..HEAD");
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

const INTRO = "# Changelog\n\nAll notable changes to this project are documented here.";
const ENTRIES = [
  "### Added",
  "",
  "- The extension opens tabs for your agent, keeping each session's tabs",
  "  in its own tab group.",
  "- An MCP server gives your agent the tab tools.",
].join("\n");
const OLD_SECTION = "## [0.1.0] - 2026-10-01\n\n### Added\n\n- The first release.";

type Reply = string | Buffer | CommandError;
type Tree = { files: Record<string, string>; commands: Record<string, Reply> };
type FakeEnv = Env & { calls: string[][] };

function changelog(...sections: string[]): string {
  return `${[INTRO, ...sections].join("\n\n")}\n`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function packageFiles(version: string, overrides: Record<string, string> = {}): Tree["files"] {
  const at = (source: string): string => overrides[source] ?? version;
  const files: Tree["files"] = {
    "package.json": json({
      name: "fixture",
      version: at("package.json"),
      workspaces: ["apps/*", "packages/*"],
    }),
    "apps/extension/manifest.json": json({ manifest_version: 3, name: "Foxhand" }),
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

/** Clean, synced main with a green CI run and no tag: the state before the first release. */
function firstReleaseTree(): Tree {
  return {
    files: {
      ...packageFiles("0.1.0"),
      "CHANGELOG.md": changelog(`## [Unreleased]\n\n${ENTRIES}`),
    },
    commands: {
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
  const xpi = `artifacts/foxhand-${version}.xpi`;
  tree.files[xpi] = "zip";
  tree.files[`artifacts/foxhand-source-${version}.zip`] = "zip";
  const released = packageFiles("0.1.0");
  Object.assign(tree.commands, {
    [TAGS]: release === "first" ? "v0.1.0" : "v0.2.0\nv0.1.0",
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
  test("passes the first release and prints the three INFO lines", () => {
    const findings = preRoll(firstReleaseTree());
    assertClean(findings);
    assert.deepEqual(texts(findings, "INFO"), [
      `CI run 101 (push) green for ${HEAD.slice(0, 12)}`,
      "listing checks: not implemented yet",
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
    tree.files["apps/extension/manifest.json"] = json({ manifest_version: 3, version: "0.0.1" });
    assertOnlyFail(
      preRoll(tree),
      /^apps\/extension\/manifest\.json has version "0\.0\.1", expected 0\.1\.0/,
    );
    tree.files["apps/extension/manifest.json"] = json({ manifest_version: 3, version: "0.1.0" });
    assertClean(preRoll(tree));
    tree.files["apps/extension/manifest.json"] = json({ manifest_version: 3, version: 1 });
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
        delete t.files["artifacts/foxhand-0.2.0.xpi"];
        delete t.commands[unzipManifest("artifacts/foxhand-0.2.0.xpi")];
      },
      /^artifacts\/foxhand-0\.2\.0\.xpi is missing; run npm run build:amo$/,
    ],
    [
      "a missing source archive",
      (t) => delete t.files["artifacts/foxhand-source-0.2.0.zip"],
      /^artifacts\/foxhand-source-0\.2\.0\.zip is missing; run npm run build:amo$/,
    ],
    [
      "an XPI of another version",
      (t) =>
        (t.commands[unzipManifest("artifacts/foxhand-0.2.0.xpi")] = Buffer.from(
          json({ version: "0.1.0" }),
        )),
      /^artifacts\/foxhand-0\.2\.0\.xpi manifest\.json has version "0\.1\.0", expected 0\.2\.0$/,
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
    ["another branch", (t) => (t.commands[BRANCH] = "release"), /^on branch "release", not main$/],
    ["a detached HEAD", (t) => (t.commands[BRANCH] = "HEAD"), /^HEAD is detached; check out main$/],
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

  test("a missing tag skips the annotation check", () => {
    const tree = prePushTree("second");
    tree.commands[POINTS_AT] = "v0.1.0";
    const env = fakeEnv(tree);
    checkPrePush(env);
    assert.ok(!env.calls.some((call) => call.includes("cat-file")));
  });
});

describe("artifacts", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "foxhand-check-release-zip-")));
  after(() => rmSync(base, { recursive: true, force: true }));
  let counter = 0;

  const PAYLOAD: Record<string, string> = {
    "manifest.json": json({ manifest_version: 3, version: "1.0.0" }),
    "background.js": "console.log(1);\n",
    "icons/foxhand.svg": "<svg/>\n",
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
    zipInto(path.join(root, "artifacts/foxhand-1.0.0.xpi"), unsigned, directories[0]);
    zipInto(path.join(root, "web-ext-artifacts/foxhand-1.0.0.xpi"), signed, directories[1]);
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
      ["background.js", "icons/foxhand.svg", "manifest.json"],
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

  const deviations: [string, Record<string, string>, Record<string, string>, RegExp][] = [
    [
      "a missing mozilla.rsa",
      PAYLOAD,
      { ...PAYLOAD, "META-INF/mozilla.sf": "sf", "META-INF/manifest.mf": "mf" },
      /^web-ext-artifacts\/foxhand-1\.0\.0\.xpi lacks META-INF\/mozilla\.rsa$/,
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
      "another manifest version",
      { ...PAYLOAD, "manifest.json": json({ version: "1.0.1" }) },
      { ...PAYLOAD, ...SIGNATURE, "manifest.json": json({ version: "1.0.1" }) },
      /^web-ext-artifacts\/foxhand-1\.0\.0\.xpi manifest\.json has version "1\.0\.1", expected 1\.0\.0$/,
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
    craftedZip(path.join(root, "web-ext-artifacts/foxhand-1.0.0.xpi"), [
      { name: "manifest.json", data: PAYLOAD["manifest.json"] ?? "" },
      { name: "background.js", data: "evil();\n", shown: "hidden/" },
      { name: "icons/foxhand.svg", data: PAYLOAD["icons/foxhand.svg"] ?? "" },
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
    assert.deepEqual(fails, ["web-ext-artifacts/foxhand-1.0.0.xpi has no manifest.json"]);
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
      /^artifacts\/foxhand-1\.0\.0\.xpi does not exist$/,
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
        `${path.join(root, "artifacts/foxhand-1.0.0.xpi").replace(`${root}/`, "")}: unsafe entry name ${JSON.stringify(name)}`,
        `web-ext-artifacts/foxhand-1.0.0.xpi: unsafe entry name ${JSON.stringify(name)}`,
      ]);
      assert.ok(!env.calls.some((call) => call.includes(name)));
      assert.ok(env.calls.some((call) => call.includes("background.js")));
    });
  }

  test("a duplicated entry name fails and is not hashed", () => {
    const tree: Tree = {
      files: { "artifacts/foxhand-1.0.0.xpi": "zip", "web-ext-artifacts/foxhand-1.0.0.xpi": "zip" },
      commands: {
        [key("unzip", "-Z1", "-UU", "artifacts/foxhand-1.0.0.xpi")]: "manifest.json\nlib.js",
        [key("unzip", "-Z1", "-UU", "web-ext-artifacts/foxhand-1.0.0.xpi")]:
          "manifest.json\nlib.js\nlib.js\nMETA-INF/mozilla.rsa\nMETA-INF/mozilla.sf\nMETA-INF/manifest.mf",
        [key("unzip", "-UU", "-p", "artifacts/foxhand-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
        [key("unzip", "-UU", "-p", "web-ext-artifacts/foxhand-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
      },
    };
    const env = fakeEnv(tree);
    const fails = texts(checkArtifacts(env, "1.0.0", undefined), "FAIL");
    assert.deepEqual(fails, [
      "web-ext-artifacts/foxhand-1.0.0.xpi: the entry lib.js is listed twice",
    ]);
    assert.ok(!env.calls.some((call) => call.includes("lib.js")));
  });

  test("an entry name with a dot or empty segment fails and is not read", () => {
    const names = ["META-INF/../evil.js", "a/./b.js", "a//c.js", "x/.."];
    const tree: Tree = {
      files: { "artifacts/foxhand-1.0.0.xpi": "zip", "web-ext-artifacts/foxhand-1.0.0.xpi": "zip" },
      commands: {
        [key("unzip", "-Z1", "-UU", "artifacts/foxhand-1.0.0.xpi")]: "manifest.json\nicons/",
        [key("unzip", "-Z1", "-UU", "web-ext-artifacts/foxhand-1.0.0.xpi")]: [
          "manifest.json",
          "icons/",
          ...Object.keys(SIGNATURE),
          ...names,
        ].join("\n"),
        [key("unzip", "-UU", "-p", "artifacts/foxhand-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
        [key("unzip", "-UU", "-p", "web-ext-artifacts/foxhand-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
      },
    };
    const env = fakeEnv(tree);
    assert.deepEqual(
      texts(checkArtifacts(env, "1.0.0", undefined), "FAIL"),
      names.map(
        (name) => `web-ext-artifacts/foxhand-1.0.0.xpi: unsafe entry name ${JSON.stringify(name)}`,
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
      "artifacts/foxhand-1.0.0.xpi: EACCES: permission denied",
      "web-ext-artifacts/foxhand-1.0.0.xpi: EACCES: permission denied",
    ]);
    assert.deepEqual(env.calls, []);
  });

  test("an unreadable entry fails and the others are still compared", () => {
    const tree: Tree = {
      files: { "artifacts/foxhand-1.0.0.xpi": "zip", "web-ext-artifacts/foxhand-1.0.0.xpi": "zip" },
      commands: {
        [key("unzip", "-Z1", "-UU", "artifacts/foxhand-1.0.0.xpi")]: "manifest.json\nlib.js",
        [key("unzip", "-Z1", "-UU", "web-ext-artifacts/foxhand-1.0.0.xpi")]:
          "manifest.json\nlib.js\nMETA-INF/mozilla.rsa\nMETA-INF/mozilla.sf\nMETA-INF/manifest.mf",
        [key("unzip", "-UU", "-p", "artifacts/foxhand-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
        [key("unzip", "-UU", "-p", "artifacts/foxhand-1.0.0.xpi", "lib.js")]: "a",
        [key("unzip", "-UU", "-p", "web-ext-artifacts/foxhand-1.0.0.xpi", "manifest.json")]: json({
          version: "1.0.0",
        }),
      },
    };
    const findings = checkArtifacts(fakeEnv(tree), "1.0.0", undefined);
    assert.deepEqual(texts(findings, "FAIL"), [
      "web-ext-artifacts/foxhand-1.0.0.xpi lib.js: `unzip -UU -p web-ext-artifacts/foxhand-1.0.0.xpi lib.js` failed (status 1): not scripted in the test",
    ]);
    assert.ok(texts(findings, "INFO").some((line) => /^lib\.js \| [0-9a-f]{12} \| -$/.test(line)));
  });
});

describe("real git", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "foxhand-check-release-git-")));
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

  /** The real git, with origin's URLs reported as GitHub's and a green CI run for any sha. */
  function github(dir: string): Env {
    const env = realEnv(dir);
    return {
      ...env,
      sh(command, args) {
        if (command === "git" && args[0] === "remote" && args[1] === "get-url") return ORIGIN_URL;
        if (command === "gh") {
          return runs(ciRun({ head_sha: /head_sha=(\w+)/.exec(args.at(-1) ?? "")?.[1] }));
        }
        return env.sh(command, args);
      },
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
      () => realEnv(dir).sh("foxhand-no-such-command", []),
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

  function releaseFiles(version: string, log: string): Record<string, string> {
    return {
      ...packageFiles(version),
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
    execFileSync("zip", ["-rqX", path.join(dir, "artifacts/foxhand-0.2.0.xpi"), "."], {
      cwd: staging,
    });
    writeFileSync(path.join(dir, "artifacts/foxhand-source-0.2.0.zip"), "zip");
    return dir;
  }

  test("pre-push passes a second release against a local origin", () => {
    assertClean(checkPrePush(github(secondRelease())));
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
    git(dir, "checkout", "-q", "main");
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
    git(dir, "checkout", "-q", "main");
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
    assert.deepEqual(out.slice(-4), [
      "INFO: listing checks: not implemented yet",
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
    [["changelog", "--verbose"], 'unknown option "--verbose" for changelog'],
    [["artifacts", "1.0.0", "--unsigned"], "--unsigned needs a path"],
    [["artifacts", "1.0.0", "--unsigned", ""], "--unsigned needs a path"],
    [["artifacts", "1.0.0", "--unsigned", "a", "--unsigned", "b"], "--unsigned is given twice"],
    [["post-roll", "1.0.0", "--unsigned", "a"], 'unknown option "--unsigned" for post-roll'],
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

  test("parseArgs builds each command", () => {
    assert.deepEqual(parseArgs(["changelog"]), { name: "changelog" });
    assert.deepEqual(parseArgs(["pre-roll"]), { name: "pre-roll", bump: undefined });
    assert.deepEqual(parseArgs(["pre-roll", "--bump=patch"]), { name: "pre-roll", bump: "patch" });
    assert.deepEqual(parseArgs(["post-roll", "0.2.0"]), { name: "post-roll", version: "0.2.0" });
    assert.deepEqual(parseArgs(["post-bump", "0.2.0"]), { name: "post-bump", version: "0.2.0" });
    assert.deepEqual(parseArgs(["pre-push"]), { name: "pre-push" });
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
