import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { integrityBase, workflowRunsTheCheck } from "./ci-integrity-base.ts";

const SCRIPT = path.resolve(import.meta.dirname, "ci-integrity-base.ts");
const CI_FILE = ".github/workflows/ci.yml";
const CI_SOURCE = readFileSync(path.resolve(import.meta.dirname, "..", CI_FILE), "utf8");
const REPO = "owner/repo";
const H = "1".repeat(40);
const C2 = "2".repeat(40);
const C1 = "3".repeat(40);
const X = "4".repeat(40);
const C0 = "d".repeat(40);
const HISTORY = [H, C2, C1];
const START = "c".repeat(40);
const ABSENT_START = "7".repeat(40);
const LIVE_BASE = "          BASE=$(node bin/ci-integrity-base.ts)";
const LIVE_BASE_REF =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
  "          BASE_REF: ${{ github.event_name == 'pull_request' && format('origin/{0}', github.base_ref) || steps.integrity-base.outputs.sha }}";
const OLD_BASE_REF =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
  "          BASE_REF: ${{ github.event_name == 'pull_request' && format('origin/{0}', github.base_ref) || (github.event_name == 'push' && github.event.before != '0000000000000000000000000000000000000000' && github.event.before) || 'none' }}";
const OLD_WORKFLOW = [
  "      - name: Test integrity",
  "        run: npm run check:test-integrity",
  "        env:",
  OLD_BASE_REF,
  "",
].join("\n");

describe("integrityBase: the nearest commit in HEAD's history whose run ran the check, or the start", () => {
  test("the commit nearest HEAD wins, not the newest run", () => {
    // A re-run of an older commit comes first in the answer.
    assert.equal(base([ciRun(C1), ciRun(C2)]), C2, "expected the run nearer HEAD to be the base");
  });

  test("HEAD itself when HEAD has a successful run", () => {
    assert.equal(base([ciRun(C1), ciRun(H)]), H, "expected HEAD's own run to make HEAD the base");
  });

  test("a run of a commit outside HEAD's history is skipped", () => {
    assert.equal(base([ciRun(X), ciRun(C1)]), C1, "a commit not in history must never be a base");
  });

  const refused: Array<[string, Record<string, unknown>]> = [
    ["a pull_request run", { event: "pull_request" }],
    ["a run with no event", { event: undefined }],
    ["a run of another workflow", { path: ".github/workflows/other.yml" }],
    ["a run from another repository", { head_repository: { full_name: "someone/fork" } }],
    ["a run whose repository has no name", { head_repository: { full_name: 7 } }],
    ["a failed run", { conclusion: "failure" }],
    ["a run with no conclusion", { conclusion: null }],
    ["a run with a null head_repository", { head_repository: null }],
    ["a run with no head_repository", { head_repository: undefined }],
  ];
  for (const [name, overrides] of refused) {
    test(`${name} does not vouch for its commit`, () => {
      assert.equal(
        base([ciRun(C2, overrides), ciRun(C1)]),
        C1,
        `${name} for C2 was taken as the base instead of C1: ${JSON.stringify(overrides)}`,
      );
    });
  }

  const malformed: Array<[string, string]> = [
    ["40 uppercase hex digits", "A".repeat(40)],
    ["39 hex digits", "2".repeat(39)],
    ["41 hex digits", "2".repeat(41)],
    ["40 hex digits and a newline", `${"2".repeat(40)}\n`],
    ["a hex prefix of a longer string", `${"2".repeat(40)}x`],
    ["a hex suffix of a longer string", `x${"2".repeat(40)}`],
  ];
  for (const [name, sha] of malformed) {
    test(`a head_sha of ${name} does not vouch`, () => {
      assert.equal(
        base([ciRun(sha), ciRun(C1)], [H, sha, C1]),
        C1,
        `a head_sha of ${name} was accepted as the base`,
      );
    });
  }

  test("a head_sha that is not a string does not vouch", () => {
    const vouched = integrityBase(
      { workflow_runs: [ciRun(2), ciRun(C1)] },
      REPO,
      [H, C1],
      () => true,
      ABSENT_START,
    );
    assert.equal(vouched, C1, "a numeric head_sha must be skipped, not thrown on");
  });

  test("a 64-digit sha vouches", () => {
    const s64 = "5".repeat(64);
    assert.equal(
      base([ciRun(s64), ciRun(C1)], [H, s64, C1]),
      s64,
      "a SHA-256 commit id must vouch",
    );
  });

  for (const event of ["push", "workflow_dispatch"]) {
    test(`a ${event} run vouches`, () => {
      assert.equal(
        base([ciRun(C2, { event }), ciRun(C1)]),
        C2,
        `a successful ${event} run of C2 was not taken as the base`,
      );
    });
  }

  test("the repository's case is ignored on both sides", () => {
    const run = ciRun(C2, { head_repository: { full_name: "owner/REPO" } });
    assert.equal(
      base([run, ciRun(C1)], HISTORY, "Owner/Repo"),
      C2,
      "a run of this repository spelled in another case was refused",
    );
  });

  const unvouched: Array<[string, unknown[]]> = [
    ["only a commit outside history has a run", [ciRun(X)]],
    ["only a pull_request run is in history", [ciRun(C2, { event: "pull_request" })]],
    ["there are no runs", []],
  ];
  for (const [name, runs] of unvouched) {
    test(`throws when ${name}`, () => {
      assert.throws(
        () => base(runs),
        new RegExp(
          `none of the newest ${runs.length} successful CI runs is for a commit in HEAD's history`,
        ),
        "a run without a vouched base must fail, never fall back",
      );
    });
  }

  for (const response of [
    null,
    {},
    { workflow_runs: {} },
    { workflow_runs: [1] },
    { workflow_runs: [null] },
    { workflow_runs: [[]] },
    { workflow_runs: [ciRun(H), "x"] },
  ]) {
    test(`throws for the answer ${JSON.stringify(response)}`, () => {
      assert.throws(
        () => integrityBase(response, REPO, HISTORY, () => true, ABSENT_START),
        /the runs API answer has no workflow_runs list of runs/,
        "an answer of the wrong shape must be refused",
      );
    });
  }

  test("a run of a commit whose workflow does not run the check does not vouch", () => {
    assert.equal(
      choose([ciRun(C2), ciRun(C1)], HISTORY, (sha) => sha !== C2),
      C1,
      "a run of C2, whose workflow skips the check, was taken as the base",
    );
  });

  test("a merged side commit listed before main's checked tip does not vouch when it skipped the check", () => {
    const M = "8".repeat(40);
    const S = "9".repeat(40);
    const M0 = "a".repeat(40);
    const P = "b".repeat(40);
    assert.equal(
      choose([ciRun(S), ciRun(M0)], [M, S, M0, P], (sha) => sha !== S),
      M0,
      "the merged side commit S, whose run skipped the check, was taken as the base",
    );
  });

  test("the start commit vouches with no run", () => {
    assert.equal(
      choose([ciRun(X)], [H, START, C1], () => true, START),
      START,
      "the start commit in history must be the base when no run in history vouches",
    );
  });

  test("a vouched commit nearer HEAD than the start commit wins over it", () => {
    assert.equal(
      choose([ciRun(C2)], [H, C2, START, C1], () => true, START),
      C2,
      "a checked commit after the start commit must be the base",
    );
  });

  test("the start commit wins over a vouched commit older than it", () => {
    assert.equal(
      choose([ciRun(C1)], [H, START, C1], () => true, START),
      START,
      "a checked commit before the start commit was taken as the base",
    );
  });

  test("a failing workflow lookup fails, never counts as not vouching", () => {
    const failing = (): boolean => {
      throw new Error("cat-file failed");
    };
    assert.throws(
      () => choose([ciRun(C2), ciRun(C1)], HISTORY, failing),
      /cat-file failed/,
      "an error reading the workflow must reach the caller",
    );
  });

  test("the workflow is read only for commits with a run, once each, nearest first", () => {
    const asked: string[] = [];
    const carriesCheck = (sha: string): boolean => {
      asked.push(sha);
      return sha !== C2;
    };
    assert.equal(
      choose([ciRun(X), ciRun(C2), ciRun(C1), ciRun(C0)], [H, C2, C2, C1, C0], carriesCheck),
      C1,
      "expected the nearest commit whose workflow runs the check",
    );
    assert.deepEqual(asked, [C2, C1], "the workflow was read for the wrong commits");
  });

  test("throws when the only run in history skipped the check and the start is absent", () => {
    assert.throws(
      () => choose([ciRun(C2)], HISTORY, () => false),
      new RegExp(
        "none of the newest 1 successful CI runs is for a commit in HEAD's history.*" +
          `does not hold the start commit ${ABSENT_START}`,
      ),
      "a history with no checked run and no start commit must fail, never fall back",
    );
  });
});

describe("workflowRunsTheCheck: a run vouches only when its ci.yml runs the check", () => {
  const notTheCheck: Array<[string, string[]]> = [
    ["the workflow from before the base step", OLD_WORKFLOW.split("\n")],
    [
      "both step lines only as comments",
      [
        "          # BASE=$(node bin/ci-integrity-base.ts)",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
        "          # BASE_REF: ${{ steps.integrity-base.outputs.sha }}",
      ],
    ],
    [
      "the base step with BASE_REF only as a comment",
      [LIVE_BASE, `          # ${LIVE_BASE_REF.trim()}`],
    ],
    [
      "BASE_REF with the base step only as a comment",
      [`          # ${LIVE_BASE.trim()}`, LIVE_BASE_REF],
    ],
    ["the base step with the old BASE_REF", [LIVE_BASE, OLD_BASE_REF]],
    ["a base step that falls back to none", [`${LIVE_BASE} || BASE=none`, LIVE_BASE_REF]],
  ];
  for (const [name, lines] of notTheCheck) {
    test(`${name} does not run the check`, () => {
      assert.equal(
        workflowRunsTheCheck(["jobs:", ...lines, ""].join("\n")),
        false,
        `${name} was taken as a workflow that runs the check`,
      );
    });
  }
});

function ciRun(sha: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: "success",
    event: "push",
    path: CI_FILE,
    head_repository: { full_name: REPO },
    head_sha: sha,
    ...overrides,
  };
}

function base(runs: unknown[], history: readonly string[] = HISTORY, repo = REPO): string {
  return integrityBase({ workflow_runs: runs }, repo, history, () => true, ABSENT_START);
}

function choose(
  runs: unknown[],
  history: readonly string[],
  carriesCheck: (sha: string) => boolean,
  start = ABSENT_START,
): string {
  return integrityBase({ workflow_runs: runs }, REPO, history, carriesCheck, start);
}

const EXPECTED_GH_PATH =
  "repos/owner/repo/actions/workflows/ci.yml/runs?status=success&per_page=100";

// Exits through process.exitCode, never process.exit(), after writing stdout: an exit right after
// a large write cuts what the pipe delivers.
const FAKE_GH = `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (args.length !== 2 || args[0] !== "api" || args[1] !== process.env.FAKE_GH_EXPECT) {
  process.stderr.write("fake gh: unexpected arguments " + JSON.stringify(args) + "\\n");
  process.exit(2);
}
process.stdout.write(fs.readFileSync(process.env.FAKE_GH_FIXTURE));
const code = Number(process.env.FAKE_GH_EXIT ?? "0");
if (code !== 0) process.stderr.write("fake gh: failing with status " + code + "\\n");
process.exitCode = code;
`;

type ScriptRun = { status: number | null; stdout: string; stderr: string; ghCalls: string[] };

describe("ci-integrity-base.ts end to end, with a fake gh and a real git repository", () => {
  test("prints the base, and fails closed when gh, REPO or the answer is wrong", () => {
    const { dir, repo, bin } = scratchRepo();
    try {
      writeWorkflow(repo, CI_SOURCE);
      const shaA = commit(repo, "A");
      const shaB = commit(repo, "B");
      commit(repo, "C");

      const fixture = path.join(dir, "runs.json");
      const padding = ciRun(X, { path: ".github/workflows/other.yml", pad: "x".repeat(1100000) });
      writeFileSync(
        fixture,
        JSON.stringify({ workflow_runs: [ciRun(shaA), ciRun(shaB), padding] }),
      );
      assert.ok(
        statSync(fixture).size > 1024 * 1024,
        "the fixture must exceed spawnSync's default 1 MiB buffer to pin maxBuffer",
      );
      const notJson = path.join(dir, "not-json.txt");
      writeFileSync(notJson, "not json");

      const ok = runScript(dir, repo, bin, { REPO, FAKE_GH_FIXTURE: fixture });
      assert.equal(ok.stderr, "", "the script wrote to stderr on success");
      assert.equal(ok.status, 0, "the script failed on a valid answer");
      assert.equal(
        ok.stdout,
        `${shaB}\n`,
        "expected the middle commit and a newline, nothing else",
      );
      assert.deepEqual(
        ok.ghCalls,
        [JSON.stringify(["api", EXPECTED_GH_PATH])],
        "gh must be called once, with the runs API path",
      );

      const failing = runScript(dir, repo, bin, {
        REPO,
        FAKE_GH_FIXTURE: fixture,
        FAKE_GH_EXIT: "1",
      });
      assert.equal(failing.status, 1, "a failing gh must fail the script");
      assert.equal(failing.stdout, "", "a failing gh must print no base");
      assert.match(failing.stderr, /^ci-integrity-base: /m, "expected the script's error line");
      assert.match(
        failing.stderr,
        /gh api repos\/owner\/repo\//,
        "the error must name the command",
      );
      assert.match(
        failing.stderr,
        /\(status 1\): fake gh: failing with status 1\n$/,
        "the error must name gh's exit status and end with gh's own stderr",
      );

      for (const repoValue of ["owner", "owner/repo/x", "owner/re po", undefined]) {
        const refused = runScript(dir, repo, bin, { REPO: repoValue, FAKE_GH_FIXTURE: fixture });
        const shown = JSON.stringify(repoValue);
        assert.equal(refused.status, 1, `REPO ${shown} was not refused`);
        assert.equal(refused.stdout, "", `REPO ${shown} printed a base`);
        assert.match(refused.stderr, /^ci-integrity-base: .*REPO/m, `REPO ${shown}: no error line`);
        assert.deepEqual(refused.ghCalls, [], `REPO ${shown} reached gh`);
      }

      const garbled = runScript(dir, repo, bin, { REPO, FAKE_GH_FIXTURE: notJson });
      assert.equal(garbled.status, 1, "an answer that is not JSON must fail the script");
      assert.equal(garbled.stdout, "", "an answer that is not JSON must print no base");
      assert.match(
        garbled.stderr,
        /^ci-integrity-base: the gh api answer is not JSON/m,
        "expected the not-JSON error line",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a merged side commit whose run skipped the check is not the base", () => {
    const { dir, repo, bin } = scratchRepo();
    try {
      writeWorkflow(repo, OLD_WORKFLOW);
      commit(repo, "P", dated("2026-01-01T00:00:00Z"));
      git(repo, ["branch", "side"]);
      writeWorkflow(repo, CI_SOURCE);
      const m0 = commit(repo, "M0", dated("2026-01-02T00:00:00Z"));
      git(repo, ["switch", "-q", "side"]);
      writeFileSync(path.join(repo, "side.txt"), "side\n");
      git(repo, ["add", "side.txt"]);
      const s = commit(repo, "S", dated("2026-01-03T00:00:00Z"));
      git(repo, ["switch", "-q", "main"]);
      merge(repo, "side", dated("2026-01-04T00:00:00Z"));
      const order = revList(repo, "--topo-order");
      assert.ok(order.indexOf(s) < order.indexOf(m0), "the setup must list S before M0");

      const fixture = path.join(dir, "runs.json");
      writeFileSync(fixture, JSON.stringify({ workflow_runs: [ciRun(s), ciRun(m0)] }));
      const result = runScript(dir, repo, bin, { REPO, FAKE_GH_FIXTURE: fixture });
      assert.equal(result.stderr, "", "the script wrote to stderr on success");
      assert.equal(result.status, 0, "the script failed on a valid answer");
      assert.equal(result.stdout, `${m0}\n`, "expected main's checked tip M0, not the side commit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a parent dated after its child does not come before the child", () => {
    const { dir, repo, bin } = scratchRepo();
    try {
      writeWorkflow(repo, CI_SOURCE);
      commit(repo, "A", dated("2026-01-01T00:00:00Z"));
      const b = commit(repo, "B", dated("2026-01-05T00:00:00Z"));
      git(repo, ["branch", "side"]);
      const y = commit(repo, "Y", dated("2026-01-02T00:00:00Z"));
      git(repo, ["switch", "-q", "side"]);
      commit(repo, "S", dated("2026-01-10T00:00:00Z"));
      git(repo, ["switch", "-q", "main"]);
      merge(repo, "side", dated("2026-01-11T00:00:00Z"));
      const byDate = revList(repo);
      assert.ok(byDate.indexOf(b) < byDate.indexOf(y), "the setup must date-order B before Y");

      const fixture = path.join(dir, "runs.json");
      writeFileSync(fixture, JSON.stringify({ workflow_runs: [ciRun(b), ciRun(y)] }));
      const result = runScript(dir, repo, bin, { REPO, FAKE_GH_FIXTURE: fixture });
      assert.equal(result.stderr, "", "the script wrote to stderr on success");
      assert.equal(result.status, 0, "the script failed on a valid answer");
      assert.equal(result.stdout, `${y}\n`, "expected Y, the child, not its later-dated parent B");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run of a commit with no ci.yml fails the script", () => {
    const { dir, repo, bin } = scratchRepo();
    try {
      const sha = commit(repo, "A");
      const fixture = path.join(dir, "runs.json");
      writeFileSync(fixture, JSON.stringify({ workflow_runs: [ciRun(sha)] }));
      const result = runScript(dir, repo, bin, { REPO, FAKE_GH_FIXTURE: fixture });
      assert.equal(result.status, 1, "a missing ci.yml must fail the script");
      assert.equal(result.stdout, "", "a missing ci.yml must print no base");
      assert.match(
        result.stderr,
        /^ci-integrity-base: git cat-file blob [0-9a-f]{40}:\.github\/workflows\/ci\.yml failed/m,
        "expected the failing git cat-file to be the error",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A temporary directory with an empty git repository on main and a bin directory holding the
// fake gh.
function scratchRepo(): { dir: string; repo: string; bin: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-integrity-base-"));
  const repo = path.join(dir, "repo");
  const bin = path.join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\n${FAKE_GH}`, { mode: 0o755 });
  git(repo, ["init", "-q", "-b", "main"]);
  return { dir, repo, bin };
}

function writeWorkflow(repo: string, text: string): void {
  mkdirSync(path.join(repo, path.dirname(CI_FILE)), { recursive: true });
  writeFileSync(path.join(repo, CI_FILE), text);
  git(repo, ["add", CI_FILE]);
}

function dated(iso: string): Record<string, string> {
  return { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
}

function revList(repo: string, ...options: string[]): string[] {
  return git(repo, ["rev-list", ...options, "HEAD"]).split("\n");
}

function runScript(
  dir: string,
  cwd: string,
  bin: string,
  vars: Record<string, string | undefined>,
): ScriptRun {
  const log = path.join(dir, "gh-calls.jsonl");
  writeFileSync(log, "");
  const env: NodeJS.ProcessEnv = {
    ...gitEnv(),
    PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
    FAKE_GH_EXPECT: EXPECTED_GH_PATH,
    FAKE_GH_LOG: log,
  };
  delete env.REPO;
  delete env.FAKE_GH_EXIT;
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) env[key] = value;
  }
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  const ghCalls = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ghCalls };
}

const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

// Returns the new commit's sha.
function commit(cwd: string, message: string, extraEnv: Record<string, string> = {}): string {
  git(cwd, [...IDENTITY, "commit", "-q", "--allow-empty", "-m", message], extraEnv);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function merge(cwd: string, branch: string, extraEnv: Record<string, string>): void {
  git(cwd, [...IDENTITY, "merge", "-q", "--no-ff", "--no-edit", branch], extraEnv);
}

function git(cwd: string, args: readonly string[], extraEnv: Record<string, string> = {}): string {
  const env = { ...gitEnv(), ...extraEnv };
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// Every GIT_ variable goes: a hook run from a linked worktree exports GIT_DIR and others, and a
// spawned git that keeps them works on the real repository. The dates a test sets come after.
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

// The workflow is read as text, without a YAML parser: every lookup asserts it found what it
// reads, so a renamed key or a reshaped step fails here instead of passing vacuously.
describe("ci.yml: non-PR runs check test integrity against a vouched base", () => {
  const validate = validateJob(CI_SOURCE);
  const steps = stepBlocks(validate);
  const integrityAt = stepIndex(steps, /^\s*(?:- )?name: Test integrity\s*$/, "Test integrity");
  const baseAt = stepIndex(steps, /^\s*(?:- )?id: integrity-base\s*$/, "id: integrity-base");
  const integrity = required(steps[integrityAt], "could not re-read the Test integrity step");
  const baseStep = required(steps[baseAt], "could not re-read the integrity-base step");

  test("Test integrity reads the base step's output for non-PR runs", () => {
    const lines = integrity.filter((line) => /^\s*BASE_REF:/.test(line));
    assert.equal(lines.length, 1, `expected one BASE_REF line in Test integrity, found ${lines}`);
    const line = required(lines[0], "no BASE_REF line");
    assert.ok(line.includes("steps.integrity-base.outputs.sha"), `${line}: not the base output`);
    assert.ok(
      line.includes("format('origin/{0}', github.base_ref)"),
      `${line}: a pull request must keep its base branch`,
    );
    assert.ok(!line.includes("github.event.before"), `${line}: still uses github.event.before`);
    assert.ok(!line.includes("'none'"), `${line}: can still skip the check with 'none'`);
  });

  test("the base step runs the script for every run but a pull request", () => {
    const trimmed = baseStep.map((line) => line.trim());
    for (const expected of [
      "if: github.event_name != 'pull_request'",
      "BASE=$(node bin/ci-integrity-base.ts)",
      'echo "sha=$BASE" >> "$GITHUB_OUTPUT"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      "GH_TOKEN: ${{ github.token }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      "REPO: ${{ github.repository }}",
    ]) {
      assert.ok(trimmed.includes(expected), `the integrity-base step lacks the line ${expected}`);
    }
  });

  // A successful run vouches for later runs, so these must fail in a run that skips the check.
  test("the base step only runs ci-integrity-base.ts and records its output", () => {
    const runAt = baseStep.findIndex((line) => /^\s*run: \|\s*$/.test(line));
    assert.ok(runAt >= 0, "the integrity-base step has no `run: |` block");
    const runIndent = required(baseStep[runAt], "no run line").search(/\S/);
    const script: string[] = [];
    for (const line of baseStep.slice(runAt + 1)) {
      if (line.trim() === "") continue;
      if (line.search(/\S/) <= runIndent) break;
      script.push(line.trim());
    }
    assert.deepEqual(
      script,
      ["BASE=$(node bin/ci-integrity-base.ts)", 'echo "sha=$BASE" >> "$GITHUB_OUTPUT"'],
      "the integrity-base step's script must be exactly these two lines",
    );
  });

  test("validate cannot pass with Test integrity skipped or failing", () => {
    const tolerated = validate.filter((line) => /^\s*(?:- )?continue-on-error:/.test(line));
    assert.deepEqual(tolerated, [], "validate must not continue past a failing step");
    const conditions = (step: string[]): string[] =>
      step.filter((line) => /^\s*(?:- )?if:/.test(line)).map((line) => line.trim());
    assert.deepEqual(conditions(integrity), [], "Test integrity must run on every validate run");
    assert.deepEqual(
      conditions(baseStep),
      ["if: github.event_name != 'pull_request'"],
      "the integrity-base step must be skipped only for a pull request",
    );
    assert.deepEqual(
      integrity.filter((line) => /^\s*(?:- )?run:/.test(line)).map((line) => line.trim()),
      ["run: npm run check:test-integrity"],
      "Test integrity must run the check script",
    );
  });

  test("workflowRunsTheCheck recognises this workflow, so its runs vouch", () => {
    assert.ok(
      workflowRunsTheCheck(CI_SOURCE),
      "workflowRunsTheCheck no longer recognises ci.yml: no run of this workflow would vouch",
    );
  });

  test("the base step comes before Test integrity", () => {
    assert.ok(baseAt < integrityAt, "the integrity-base step must run before Test integrity");
  });

  test("validate may read contents and actions, nothing more", () => {
    const start = validate.findIndex((line) => /^ {4}permissions:\s*$/.test(line));
    assert.ok(start >= 0, `${CI_FILE}: validate has no permissions block at indent 4`);
    const scopes: string[] = [];
    for (const line of validate.slice(start + 1)) {
      if (line.trim() === "") continue;
      if (!/^ {5,}/.test(line)) break;
      scopes.push(line.trim());
    }
    assert.deepEqual(
      scopes.sort(),
      ["actions: read", "contents: read"],
      "validate's permissions must be exactly contents: read and actions: read",
    );
  });
});

// The lines of the validate job: everything after its header up to the next non-blank line at
// indent 2 or less.
function validateJob(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^ {2}validate:\s*$/.test(line));
  assert.ok(start >= 0, `${CI_FILE}: no validate job at indent 2`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^ {3,}/.test(line)) break;
    body.push(line);
  }
  return body;
}

// Steps split at their `- ` lines at indent 6; the lines before the first step are dropped.
function stepBlocks(job: string[]): string[][] {
  const steps: string[][] = [];
  for (const line of job) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else steps.at(-1)?.push(line);
  }
  assert.ok(steps.length > 0, `${CI_FILE}: no steps found in validate at indent 6`);
  return steps;
}

function stepIndex(steps: string[][], pattern: RegExp, label: string): number {
  const matches = steps.flatMap((step, index) =>
    step.some((line) => pattern.test(line)) ? [index] : [],
  );
  assert.equal(matches.length, 1, `${CI_FILE}: expected one validate step with ${label}`);
  return required(matches[0], `${CI_FILE}: no validate step with ${label}`);
}

function required<T>(value: T | undefined, message: string): T {
  assert.ok(value !== undefined, message);
  return value;
}
