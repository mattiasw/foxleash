// A `node --test` reporter that prints failures in full and passing tests not at all. A green
// run ends in one line of counts and one of coverage totals. Set FOXHAND_TEST_REPORTER=spec
// for the stock per-test output.
//
// Test stdout and stderr are replayed only when something failed: a test file that crashes
// while loading reaches the reporter as a bare "test failed", with the real error on stderr.
import { Readable } from "node:stream";
import { spec, type TestEvent } from "node:test/reporters";
import { inspect } from "node:util";

type Failure = Extract<TestEvent, { type: "test:fail" }>["data"];
type Coverage = Extract<TestEvent, { type: "test:coverage" }>;

// The closing counts arrive as one diagnostic each ("tests 812", "pass 812", ...).
const COUNT = /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \S+$/;

export default async function* report(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const failures: { path: string; failure: Failure }[] = [];
  const counts: string[] = [];
  const notes: string[] = [];
  const output: string[] = [];
  const running = new Map<string, string[]>();
  let rootError = false;
  let coverage: Coverage | undefined;
  for await (const event of source) {
    switch (event.type) {
      case "test:start": {
        const names = (running.get(event.data.file ?? "") ?? []).slice(0, event.data.nesting);
        names.push(event.data.name);
        running.set(event.data.file ?? "", names);
        break;
      }
      case "test:stdout":
      case "test:stderr":
        output.push(event.data.message);
        break;
      case "test:fail":
        // A suite that failed only because a test inside it did repeats that test's entry.
        if (failureType(event.data.details.error) !== "subtestsFailed") {
          const parents = (running.get(event.data.file ?? "") ?? []).slice(0, event.data.nesting);
          failures.push({ path: [...parents, event.data.name].join(" > "), failure: event.data });
        }
        break;
      case "test:diagnostic":
        // Top-level diagnostics: the counts, coverage floor errors, and warnings such as a
        // test's asynchronous activity after it ended.
        if (event.data.nesting !== 0) break;
        if (event.data.level === "info" && COUNT.test(event.data.message)) {
          counts.push(event.data.message);
        } else {
          notes.push(`${event.data.level === "error" ? "✖" : "ℹ"} ${event.data.message}\n`);
          if (event.data.level === "error") rootError = true;
        }
        break;
      case "test:coverage":
        coverage = event;
        break;
    }
  }
  for (const { path, failure } of failures) {
    yield `\n✖ ${path}${location(failure)}\n`;
    yield `${inspect(failure.details.error, { depth: 6, colors: false })}\n`;
  }
  if (failures.length > 0 && output.length > 0) {
    yield `\n--- captured test output (stdout and stderr) ---\n${output.join("")}`;
  }
  if (failures.length > 0) yield "\n";
  if (coverage !== undefined && rootError) yield await coverageTable(coverage);
  yield* notes;
  yield `ℹ ${counts.join(", ")}\n`;
  if (coverage !== undefined) yield `ℹ ${coverageTotals(coverage)}\n`;
}

function failureType(error: Error): unknown {
  return "failureType" in error ? error.failureType : undefined;
}

function location(failure: Failure): string {
  if (failure.file === undefined) return "";
  const line = failure.line === undefined ? "" : `:${failure.line}:${failure.column ?? 1}`;
  return ` (${failure.file}${line})`;
}

// A missed coverage floor needs the per-file table to find the gap; the stock spec reporter
// renders it from the coverage event alone.
async function coverageTable(coverage: Coverage): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of Readable.from([coverage]).compose(spec())) chunks.push(String(chunk));
  return chunks.join("");
}

function coverageTotals(coverage: Coverage): string {
  const totals = coverage.data.summary.totals;
  const percent = (value: number): string => `${value.toFixed(2)}%`;
  return [
    `coverage: lines ${percent(totals.coveredLinePercent)}`,
    `branches ${percent(totals.coveredBranchPercent)}`,
    `functions ${percent(totals.coveredFunctionPercent)}`,
  ].join(", ");
}
