// Prints the commit CI's test integrity check compares HEAD with: the newest commit in HEAD's
// history that has a successful push or workflow_dispatch run of ci.yml in this repository.
// Reads REPO (owner/name) from the environment; needs `gh` (with GH_TOKEN) and `git`.
import { spawnSync } from "node:child_process";

const WORKFLOW = ".github/workflows/ci.yml";
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const COMMAND_TIMEOUT_MS = 60_000;

function main(): void {
  try {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: the CI step sets it; no turbo task runs this
    const repo = process.env.REPO ?? "";
    if (!REPO_SLUG.test(repo)) {
      throw new Error(`REPO must be owner/name, got ${JSON.stringify(repo)}`);
    }
    const answer = run("gh", [
      "api",
      `repos/${repo}/actions/workflows/ci.yml/runs?status=success&per_page=100`,
    ]);
    let response: unknown;
    try {
      response = JSON.parse(answer);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`the gh api answer is not JSON: ${reason}`);
    }
    const history = run("git", ["rev-list", "HEAD"])
      .split("\n")
      .filter((line) => line !== "");
    process.stdout.write(`${integrityBase(response, repo, history)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ci-integrity-base: ${message}\n`);
    process.exitCode = 1;
  }
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
    encoding: "utf8",
  });
  if (result.status === 0 && result.error === undefined) return result.stdout;
  const cause = result.error
    ? `error ${result.error.message}`
    : result.signal
      ? `signal ${result.signal}`
      : `status ${result.status}`;
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const detail = stderr === "" ? "" : `: ${stderr}`;
  throw new Error(`${[command, ...args].join(" ")} failed (${cause})${detail}`);
}

export function integrityBase(response: unknown, repo: string, history: readonly string[]): string {
  const runs = isRecord(response) ? response.workflow_runs : undefined;
  if (!Array.isArray(runs) || !runs.every(isRecord)) {
    throw new Error("the runs API answer has no workflow_runs list of runs");
  }
  const vouched = new Set<unknown>();
  for (const ciRun of runs) {
    if (vouches(ciRun, repo)) vouched.add(ciRun.head_sha);
  }
  const base = history.find((sha) => vouched.has(sha));
  // No fallback (none, github.event.before, origin/main): a run that passes without a real base
  // becomes a base for later runs.
  if (base === undefined) {
    throw new Error(
      `none of the newest ${runs.length} successful CI runs is for a commit in HEAD's history ` +
        "(only that one page of runs is read)",
    );
  }
  return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vouches(ciRun: Record<string, unknown>, repo: string): boolean {
  const headRepository = ciRun.head_repository;
  return (
    ciRun.conclusion === "success" &&
    // A pull_request run checks a merge commit, not its head_sha.
    (ciRun.event === "push" || ciRun.event === "workflow_dispatch") &&
    ciRun.path === WORKFLOW &&
    isRecord(headRepository) &&
    typeof headRepository.full_name === "string" &&
    headRepository.full_name.toLowerCase() === repo.toLowerCase() &&
    typeof ciRun.head_sha === "string" &&
    SHA.test(ciRun.head_sha)
  );
}

if (import.meta.main) main();
