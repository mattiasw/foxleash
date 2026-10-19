import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    // Anything else after a failed gh pr merge (a conflict on the same head) must stay an error.
    const { name, block } = mergingJob(merging);
    const lines = block.split("\n").map((line) => line.trim());
    const notices = lines.flatMap((line, i) => (line.startsWith('echo "::notice::') ? [i] : []));
    assert.equal(notices.length, 1, `job "${name}" should print exactly one ::notice::`);
    const at = required(notices[0], `job "${name}": could not re-read its ::notice:: line`);
    const branch = required(lines[at - 1], `job "${name}": nothing above its ::notice:: line`);
    assert.equal(
      branch,
      'elif [ "$PR_STATE" = "OPEN" ] && [ -n "$PR_HEAD" ] && [ "$PR_HEAD" != "$SHA" ]; then',
      `job "${name}"'s ::notice:: branch must require an open PR whose head moved`,
    );
    assert.deepEqual(
      [lines[at + 1], lines[at + 2]?.startsWith('echo "::error::'), lines[at + 3]],
      ["else", true, "exit 1"],
      `job "${name}" must fail with an ::error:: in every other case after a failed merge`,
    );
    // The chain opens on MERGED, and no other branch comes before the notice's.
    const opens = lines.flatMap((line, i) =>
      line === 'if [ "$PR_STATE" = "MERGED" ]; then' ? [i] : [],
    );
    assert.equal(opens.length, 1, `job "${name}" should test for a MERGED PR exactly once`);
    const open = required(opens[0], `job "${name}": could not re-read its MERGED test`);
    assert.ok(open < at, `job "${name}" tests for a MERGED PR after its ::notice:: branch`);
    // PR_STATE and PR_HEAD read from the PR right above the chain, so the head compared with $SHA
    // is the PR's current one.
    assert.deepEqual(
      [lines[open - 2], lines[open - 1]],
      [
        `PR_INFO=$(gh pr view "$PR" --repo "$REPO" --json state,headRefOid --jq '.state + " " + .headRefOid')`,
        'read -r PR_STATE PR_HEAD <<< "$PR_INFO"',
      ],
      `job "${name}" must read the PR's state and current head right above its MERGED test`,
    );
    assert.ok(
      !lines.slice(open + 1, at - 1).some((line) => /^(if|elif|else|fi)\b/.test(line)),
      `job "${name}" has another branch between its MERGED and head-moved branches`,
    );
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
