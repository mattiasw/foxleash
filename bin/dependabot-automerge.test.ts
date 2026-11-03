import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

// The workflow is read as text, without a YAML parser: every lookup asserts that it found what
// it reads, so a renamed key or a reshaped script fails here instead of passing vacuously.

const AUTOMERGE_FILE = ".github/workflows/dependabot-automerge.yml";
const AUTOMERGE_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "..", ".github", "workflows", "dependabot-automerge.yml"),
  "utf8",
);

describe("dependabot-automerge.yml: a merge rides only on the checks of the sha it merges", () => {
  // Identified by the command it runs: exactly one job may call gh pr merge.
  const merging = [...jobBlocks(AUTOMERGE_SOURCE, AUTOMERGE_FILE)].filter(([, block]) =>
    block.includes("gh pr merge"),
  );

  test("exactly one job merges", () => {
    assert.equal(
      merging.length,
      1,
      `expected exactly one job in ${AUTOMERGE_FILE} running "gh pr merge", found ${merging.length}`,
    );
  });

  test("the merging job runs after every successful run, whatever its event", () => {
    // Only a pull_request run vouches for the merge (the required-workflow check below), but any
    // successful completion must re-check: an event filter here would skip a workflow_dispatch
    // run that finishes after the pull_request run, and the PR would wait for its next push.
    const { name, block } = mergingJob(merging);
    const condition = group(
      /^ {4}if: (.+)$/m.exec(block),
      1,
      `job "${name}" declares no one-line job-level "if:" this test can read`,
    );
    // Exactly the success clause: any other conjunct (the event, the actor) filters runs out.
    assert.equal(
      condition.trim(),
      "github.event.workflow_run.conclusion == 'success'",
      `job "${name}"'s if: is "${condition}"; it must be the success clause alone`,
    );
    // The whole job, so a step's if: or a script reading the event cannot filter it either.
    assert.doesNotMatch(
      block,
      /workflow_run(\.event\b|\[\s*['"]event)/,
      `job "${name}" reads workflow_run.event; only the required-workflow check filters the event`,
    );
  });

  test("gh pr merge is bound to the head sha the checks ran on", () => {
    // Without --match-head-commit a branch that moved after its checks (a Dependabot rebase)
    // would be merged on the old commit's green run.
    const { name, block } = mergingJob(merging);
    const calls = block.split("\n").filter((line) => line.includes("gh pr merge"));
    assert.equal(calls.length, 1, `job "${name}" should call "gh pr merge" on exactly one line`);
    const call = required(calls[0], `job "${name}": could not re-read its "gh pr merge" line`);
    assert.doesNotMatch(
      call,
      /\\\s*$/,
      `job "${name}" continues "gh pr merge" over lines; only a one-line call is understood here`,
    );
    // A YAML-quoted `run:` value would read its YAML quotes as shell quotes.
    assert.doesNotMatch(
      call,
      /^\s*(?:-\s+)?run:/,
      `job "${name}" calls "gh pr merge" on its run: line; only a line of a "run: |" block is read here`,
    );
    // stripShellComment misreads quotes in these, and could then keep a comment as the flag.
    assert.doesNotMatch(
      call,
      /\$\(|`|\$'/,
      `job "${name}"'s "gh pr merge" line holds $(...), a backtick or $'...', which is not read here`,
    );
    assert.ok(
      call.includes('--match-head-commit "$SHA"'),
      `job "${name}"'s "gh pr merge" call does not pass --match-head-commit "$SHA": ${call.trim()}`,
    );
    assert.match(
      block,
      /^ {10}SHA: \$\{\{ github\.event\.workflow_run\.head_sha }}$/m,
      `job "${name}" no longer sets SHA to github.event.workflow_run.head_sha`,
    );
    // Every bare SHA is that env: key: an assignment, read or loop over SHA would merge another
    // commit on these checks.
    const names = block.match(/(?<![\w${])SHA\b/g) ?? [];
    assert.equal(
      names.length,
      1,
      `job "${name}" names SHA outside its env: line, so the merged sha may not be the checked one`,
    );
  });

  test("the Dependabot PR lookup reads past gh's default of 30 open PRs", () => {
    const { name, block } = mergingJob(merging);
    const limit = Number(
      group(
        /gh pr list [^)]*--limit (\d+)/.exec(block),
        1,
        `job "${name}"'s "gh pr list" passes no --limit`,
      ),
    );
    assert.ok(limit >= 100, `job "${name}" lists only ${limit} open PRs`);
  });

  test("the required-workflow check counts only pull_request runs", () => {
    // A push or workflow_dispatch run of the sha tests the branch head, not its merge with main,
    // so it must not vouch for the merge. Runs from forks with the same sha never count.
    const { name, block } = mergingJob(merging);
    const selects = block.match(/select\(\.name == \$WORKFLOW_NAME[^)]*\)/g) ?? [];
    assert.equal(
      selects.length,
      1,
      `job "${name}" should select the required workflow's runs once, found ${selects.length}`,
    );
    assert.equal(
      selects[0],
      'select(.name == $WORKFLOW_NAME and .event == "pull_request" and .head_repository.id == .repository.id)',
      `job "${name}" counts runs of another event or from forks for a required workflow`,
    );
  });

  test("a failed merge passes quietly only when merged already or the head moved", () => {
    // Anything else after a failed gh pr merge (a closed PR, a refusal on the same head that
    // outlasts the retries) must stay an error.
    const merged = runJob("automerge", {
      "pr merge": [REFUSED],
      "pr view": [prView("MERGED", SHA)],
    });
    assert.equal(merged.status, 0, merged.stderr);
    assert.deepEqual(keys(merged), ["pr list", "api", "pr checks", "pr merge", "pr view"]);
    assert.equal(merged.output, "merged=true\n");

    const moved = runJob("automerge", {
      "pr merge": [REFUSED],
      "pr view": [prView("OPEN", OTHER_SHA)],
    });
    assert.equal(moved.status, 0, moved.stderr);
    assert.deepEqual(keys(moved), ["pr list", "api", "pr checks", "pr merge", "pr view"]);
    assert.match(moved.stdout, /^::notice::PR #7's head moved to /m);
    assert.equal(moved.output, "");

    const closed = runJob("automerge", {
      "pr merge": [REFUSED],
      "pr view": [prView("CLOSED", SHA)],
    });
    assert.equal(closed.status, 1);
    assert.deepEqual(keys(closed), ["pr list", "api", "pr checks", "pr merge", "pr view"]);
    assert.match(closed.stdout, /^::error::Failed to merge PR #7 \(state: CLOSED\)\.$/m);
    assert.equal(closed.output, "");

    // An empty head is not a moved head: read as moved, the job would pass with nothing merged.
    const headless = runJob("automerge", {
      "pr merge": [REFUSED],
      "pr view": [prView("OPEN", "")],
    });
    assert.equal(headless.status, 1);
    assert.deepEqual(keys(headless), [...CHECKED, ...REFUSED_THRICE]);
    assert.match(headless.stdout, /^::error::Failed to merge PR #7 \(state: OPEN\)\.$/m);
    assert.doesNotMatch(headless.stdout, /::notice::/);
    assert.equal(headless.output, "");
  });
});

describe("dependabot-automerge.yml: the scripts, run against a fake gh", () => {
  test("a merge accepted at once is made once, without a wait", () => {
    const run = runJob("automerge", { "pr merge": [{}] });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(keys(run), [...CHECKED, "pr merge"]);
    assert.deepEqual(argsOf(run, "pr merge"), [MERGE_ARGS]);
    assert.equal(run.output, "merged=true\n");
  });

  test("a merge refused while the PR is open on the checked sha is tried again", () => {
    const run = runJob("automerge", {
      "pr merge": [REFUSED, {}],
      "pr view": [prView("OPEN", SHA)],
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(keys(run), [...CHECKED, "pr merge", "pr view", "sleep", "pr merge"]);
    assert.deepEqual(argsOf(run, "pr merge"), [MERGE_ARGS, MERGE_ARGS]);
    assert.equal(run.output, "merged=true\n");
  });

  test("a merge refused on every attempt fails after three", () => {
    const run = runJob("automerge", { "pr merge": [REFUSED], "pr view": [prView("OPEN", SHA)] });
    assert.equal(run.status, 1);
    assert.deepEqual(keys(run), [...CHECKED, ...REFUSED_THRICE]);
    assert.deepEqual(argsOf(run, "pr merge"), [MERGE_ARGS, MERGE_ARGS, MERGE_ARGS]);
    assert.match(run.stdout, /^::error::Failed to merge PR #7 \(state: OPEN\)\.$/m);
    assert.equal(run.output, "");
  });

  test("a PR state that cannot be read is retried and never reads as merged", () => {
    const recovered = runJob("automerge", {
      "pr merge": [REFUSED, {}],
      "pr view": [VIEW_FAILED],
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(keys(recovered), [...CHECKED, "pr merge", "pr view", "sleep", "pr merge"]);
    assert.deepEqual(argsOf(recovered, "pr merge"), [MERGE_ARGS, MERGE_ARGS]);
    assert.equal(recovered.output, "merged=true\n");

    const failed = runJob("automerge", { "pr merge": [REFUSED], "pr view": [VIEW_FAILED] });
    assert.equal(failed.status, 1);
    assert.deepEqual(keys(failed), [...CHECKED, ...REFUSED_THRICE]);
    assert.match(failed.stdout, /^::error::Failed to merge PR #7 \(state: unknown\)\.$/m);
    assert.equal(failed.output, "");
  });

  test("starting CI on main is tried again after a failure", () => {
    const run = runJob("ci-on-main", { "workflow run": [DISPATCH_FAILED, {}] });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(keys(run), ["workflow run", "sleep", "workflow run"]);
    assert.deepEqual(argsOf(run, "workflow run"), [DISPATCH_ARGS, DISPATCH_ARGS]);
  });

  test("starting CI on main fails after three refused attempts", () => {
    const run = runJob("ci-on-main", { "workflow run": [DISPATCH_FAILED] });
    assert.equal(run.status, 1);
    assert.deepEqual(keys(run), ["workflow run", "sleep", "workflow run", "sleep", "workflow run"]);
    assert.deepEqual(argsOf(run, "workflow run"), [DISPATCH_ARGS, DISPATCH_ARGS, DISPATCH_ARGS]);
    assert.match(run.stdout, /^::error::Could not start CI on main\./m);
  });
});

describe("stripShellComment: what counts as a trailing comment", () => {
  test("a flag spelled only after a comment marker is cut away", () => {
    for (const line of [
      'if ! gh pr merge "$PR" --squash --delete-branch --repo "$REPO"; then # --match-head-commit "$SHA"',
      'gh pr merge "$PR"\t# --match-head-commit "$SHA"',
      // Inside single quotes a backslash is literal, so the quote closes right after it.
      "gh pr merge 'a\\' # --match-head-commit \"$SHA\"",
      ...["|", "&", ";", "(", ")", "<", ">"].map(
        (operator) => `gh pr merge "$PR" --squash${operator}# --match-head-commit "$SHA"`,
      ),
    ]) {
      const code = stripShellComment(line);
      assert.ok(!code.includes("--match-head-commit"), `not cut: ${line}`);
      assert.ok(code.includes("gh pr merge"), `cut too early: ${line}`);
    }
  });

  test("a # inside quotes, inside a word, or escaped is not a comment", () => {
    for (const line of [
      'gh pr merge "$PR" --body "fix #1" --match-head-commit "$SHA"',
      "gh pr merge 'a #1' --match-head-commit \"$SHA\"",
      // Split so Biome does not read "${" as a stray template placeholder.
      `echo ${"$"}{#SHA} a#b --match-head-commit "$SHA"`,
      'gh pr merge \\# --match-head-commit "$SHA"',
      'gh pr merge a\\ #b --match-head-commit "$SHA"',
    ]) {
      assert.equal(stripShellComment(line), line);
    }
  });
});

// The scripts run as GitHub runs them, against a fake gh that answers from a scenario. The fake
// gh and a fake sleep come first on PATH, and the environment is built from scratch, so no token
// and no real gh is reachable; every test asserts the exact calls the fakes logged.
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const FAKE_REPO = "example/fake";
const MERGE_ARGS = [
  "pr",
  "merge",
  "7",
  "--squash",
  "--delete-branch",
  "--match-head-commit",
  SHA,
  "--repo",
  FAKE_REPO,
];
const DISPATCH_ARGS = ["workflow", "run", "ci.yml", "--ref", "main", "--repo", FAKE_REPO];
const CHECKED = ["pr list", "api", "pr checks"];
const REFUSED_THRICE = [
  "pr merge",
  "pr view",
  "sleep",
  "pr merge",
  "pr view",
  "sleep",
  "pr merge",
  "pr view",
];
const REFUSED: GhResponse = {
  code: 1,
  stderr: "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)",
};
const VIEW_FAILED: GhResponse = { code: 1, stderr: "HTTP 502: Bad Gateway" };
const DISPATCH_FAILED: GhResponse = { code: 1, stderr: "HTTP 500: Internal Server Error" };

type GhKey = "pr list" | "pr view" | "pr checks" | "pr merge" | "workflow run" | "api";
// json is printed, or filtered through the call's --jq as gh does; code is the exit status.
type GhResponse = { json?: unknown; stderr?: string; code?: number };
// Each key's responses are consumed in call order; the last one repeats.
type Scenario = Partial<Record<GhKey, GhResponse[]>>;
type FakeCall = { key: string; args: string[] };
type JobRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  calls: FakeCall[];
};

function runJob(job: string, overrides: Scenario): JobRun {
  const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
  assert.equal(jq.status, 0, "jq is required: the auto-merge tests run the workflow's jq filters");
  const dir = mkdtempSync(path.join(tmpdir(), "foxhand-automerge-"));
  try {
    const bin = path.join(dir, "bin");
    const home = path.join(dir, "home");
    const ghConfig = path.join(dir, "gh-config");
    for (const created of [bin, home, ghConfig]) mkdirSync(created);
    writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\n${FAKE_GH}`, { mode: 0o755 });
    writeFileSync(path.join(bin, "sleep"), FAKE_SLEEP, { mode: 0o755 });
    const scenario = path.join(dir, "scenario.json");
    writeFileSync(scenario, JSON.stringify({ ...defaultScenario(), ...overrides }));
    const log = path.join(dir, "calls.jsonl");
    writeFileSync(log, "");
    const output = path.join(dir, "github-output");
    writeFileSync(output, "");
    const script = path.join(dir, "script.sh");
    writeFileSync(script, runBlock(job));
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
        HOME: home,
        GH_CONFIG_DIR: ghConfig,
        GH_TOKEN: "fake-token",
        REPO: FAKE_REPO,
        SHA,
        TRIGGERING_WORKFLOW: "CI",
        GITHUB_OUTPUT: output,
        FAKE_GH_SCENARIO: scenario,
        FAKE_GH_LOG: log,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: readFileSync(output, "utf8"),
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean).map(parseCall),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function keys(run: JobRun): string[] {
  return run.calls.map((call) => call.key);
}

function argsOf(run: JobRun, key: GhKey): string[][] {
  return run.calls.filter((call) => call.key === key).map((call) => call.args);
}

function prView(state: string, headRefOid: string): GhResponse {
  return { json: { state, headRefOid } };
}

// Every check before the merge passes.
function defaultScenario(): Scenario {
  return {
    "pr list": [{ json: [{ number: 7, headRefOid: SHA, author: { login: "app/dependabot" } }] }],
    api: [
      {
        json: {
          workflow_runs: [
            {
              name: "CI",
              event: "pull_request",
              head_repository: { id: 1 },
              repository: { id: 1 },
              run_started_at: "2026-11-01T00:00:00Z",
              conclusion: "success",
            },
          ],
        },
      },
    ],
    "pr checks": [{ json: [{ name: "validate", bucket: "pass" }] }],
  };
}

// A job's single `run: |` script, dedented, from the raw text: comments are harmless to bash. The
// block ends at the first non-empty line indented less than its first line, so a YAML comment
// above the next job is not read as a command.
function runBlock(job: string): string {
  const body = required(
    jobBlocks(AUTOMERGE_SOURCE, AUTOMERGE_FILE).get(job),
    `${AUTOMERGE_FILE} has no job "${job}"`,
  );
  const lines = body.split("\n");
  const starts = lines.flatMap((line, i) => (/^\s*(?:-\s+)?run: \|\s*$/.test(line) ? [i] : []));
  assert.equal(starts.length, 1, `job "${job}" should hold exactly one "run: |" block`);
  const rest = lines.slice(required(starts[0], `job "${job}": no "run: |" line`) + 1);
  const first = required(
    rest.find((line) => line.trim() !== ""),
    `job "${job}"'s "run: |" block is empty`,
  );
  const indent = first.length - first.trimStart().length;
  const script: string[] = [];
  for (const line of rest) {
    if (line.trim() === "") {
      script.push("");
      continue;
    }
    if (line.length - line.trimStart().length < indent) break;
    script.push(line.slice(indent));
  }
  const text = `${script.join("\n").trimEnd()}\n`;
  assert.ok(
    !text.includes("${{"),
    `job "${job}"'s script holds an expression this test cannot expand`,
  );
  return text;
}

function parseCall(line: string): FakeCall {
  const value: unknown = JSON.parse(line);
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      "key" in value &&
      typeof value.key === "string" &&
      "args" in value &&
      Array.isArray(value.args) &&
      value.args.every((arg) => typeof arg === "string"),
    `the fake gh logged a line this test cannot read: ${line}`,
  );
  return { key: value.key, args: value.args };
}

// Each call is a new process, so its index is the number of earlier calls with its key.
const FAKE_GH = `const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const key = args[0] === "api" ? "api" : args.slice(0, 2).join(" ");
const log = process.env.FAKE_GH_LOG;
const index = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean)
  .filter((line) => JSON.parse(line).key === key).length;
fs.appendFileSync(log, JSON.stringify({ key, args }) + "\\n");
const responses = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, "utf8"))[key];
if (!Array.isArray(responses) || responses.length === 0) {
  process.stderr.write("fake gh: no scenario for " + JSON.stringify(key) + "\\n");
  process.exit(99);
}
const response = responses[Math.min(index, responses.length - 1)];
if (response.stderr) process.stderr.write(response.stderr + "\\n");
if (response.json !== undefined) {
  const text = JSON.stringify(response.json);
  const jqAt = args.indexOf("--jq");
  if (jqAt < 0) {
    process.stdout.write(text + "\\n");
  } else {
    const jq = spawnSync("jq", ["-r", args[jqAt + 1]], { input: text, encoding: "utf8" });
    if (jq.status !== 0) {
      process.stderr.write(jq.stderr ?? "");
      process.exit(jq.status ?? 1);
    }
    process.stdout.write(jq.stdout);
  }
}
process.exit(response.code ?? 0);
`;

const FAKE_SLEEP = `#!/bin/sh
printf '{"key":"sleep","args":["%s"]}\\n' "$1" >> "$FAKE_GH_LOG"
`;

// The merging job's block with every line's trailing comment cut, YAML comments included, so no
// comment can supply a clause, a flag or a line the tests read.
function mergingJob(merging: Array<[string, string]>): { name: string; block: string } {
  const [name, block] = required(merging[0], `no job in ${AUTOMERGE_FILE} runs "gh pr merge"`);
  return { name, block: block.split("\n").map(stripShellComment).join("\n") };
}

// noUncheckedIndexedAccess makes every index read `T | undefined`. These two turn that into an
// assertion carrying the spelling we expected, rather than a non-null bang: a helper that stops
// matching then says so instead of throwing a bare TypeError three lines later.
function required<T>(value: T | undefined, message: string): T {
  assert.ok(value !== undefined, message);
  return value;
}

function group(match: RegExpMatchArray | null, index: number, message: string): string {
  assert.ok(match, message);
  return required(match[index], message);
}

// Each job under `jobs:` by name, with the lines of its body. Job headers sit at indent 2.
function jobBlocks(source: string, file: string): Map<string, string> {
  const jobs = topLevelEntry(source, "jobs", file).body;
  const blocks = new Map<string, string>();
  const header = /^ {2}([A-Za-z0-9_-]+):\s*$/;
  let name: string | null = null;
  let body: string[] = [];
  for (const line of jobs.split("\n")) {
    const match = header.exec(line);
    if (match) {
      if (name !== null) blocks.set(name, body.join("\n"));
      name = group(match, 1, `${file}: could not read a job name under "jobs:"`);
      body = [];
    } else if (name !== null) {
      body.push(line);
    }
  }
  if (name !== null) blocks.set(name, body.join("\n"));
  assert.ok(
    blocks.size > 0,
    `${file}: no job headers found under "jobs:" at indent 2; the file's shape changed and ` +
      "every assertion below would be vacuous",
  );
  return blocks;
}

// A top-level key's inline value (everything after the colon on its own line) and its body
// (every following line until the next column-0 line). Anchored at column 0, so a job's
// indented `name:` can never be mistaken for the workflow's.
function topLevelEntry(
  source: string,
  key: string,
  file: string,
): { inline: string; body: string } {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  assert.ok(start >= 0, `${file}: no top-level "${key}:" key at column 0`);
  const inline = required(lines[start], `${file}: could not re-read the "${key}:" line`)
    .slice(key.length + 1)
    .trim();
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return { inline, body: body.join("\n") };
}

// A shell line without its trailing comment. A `#` starts a comment only outside single and
// double quotes and at the start of a word: at line start, or after an unescaped, unquoted space,
// tab or other bash metacharacter (`|&;()<>`, so `cmd;# x` is a comment too). `a#b`, `${#VAR}`
// and `a\ #b` are ordinary text to the shell. A backslash outside single quotes escapes the next
// character, so `\#` is not a comment either. Without this, a flag spelled only in a trailing
// comment (`gh pr merge ... # --match-head-commit "$SHA"`) would satisfy a substring check on
// the line. It reads one line: it does not parse `$(...)` (it cuts `$(x)#y`, one word to the
// shell), backticks, `$'...'`, heredocs or a quote opened on an earlier line.
function stripShellComment(line: string): string {
  let quote: string | null = null;
  let wordStart = true;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    const wasWordStart = wordStart;
    wordStart = false;
    if (char === "\\" && quote !== "'") {
      index += 1;
    } else if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/[\s|&;()<>]/.test(char)) {
      wordStart = true;
    } else if (char === "#" && wasWordStart) {
      return line.slice(0, index);
    }
  }
  return line;
}
