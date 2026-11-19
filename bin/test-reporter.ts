// A `node --test` reporter that prints failures in full and passing tests not at all. A green
// run prints the diagnostics its tests report (`t.diagnostic`, which the end-to-end tests use
// for timings), then one line of counts and one of coverage totals. Set
// FOXLEASH_TEST_REPORTER=spec for the stock per-test output.
//
// Test stdout and stderr are replayed only when something failed: a test file that crashes
// while loading reaches the reporter as a bare "test failed", with the real error on stderr.
//
// A run ended by SIGINT or SIGTERM prints, at once, for each running file, the test that was
// running or the test after which its hooks or teardown were running, then the failures so far:
// the runner exits before the run's events end, so the end-of-run output never comes.
import { relative } from "node:path";
import { Readable } from "node:stream";
import { spec, type TestEvent } from "node:test/reporters";
import { inspect } from "node:util";

type Failure = Extract<TestEvent, { type: "test:fail" }>["data"];
type Coverage = Extract<TestEvent, { type: "test:coverage" }>;
type Failed = { path: string; failure: Failure };
// `running` holds the tests that started and have not ended, outermost first; `ended` the path of
// the test that ended last, while no test has started after it.
type Progress = { running: string[]; ended: string | undefined };

// The closing counts arrive as one diagnostic each ("tests 812", "pass 812", ...).
const COUNT = /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \S+$/;

export default async function* report(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const failures: Failed[] = [];
  const counts: string[] = [];
  const notes: string[] = [];
  const output: string[] = [];
  const running = new Map<string, string[]>();
  const progress = new Map<string, Progress>();
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
      case "test:dequeue": {
        const file = progressOf(progress, event.data.file ?? "");
        file.running = [...file.running.slice(0, event.data.nesting), event.data.name];
        file.ended = undefined;
        break;
      }
      case "test:complete": {
        const file = progressOf(progress, event.data.file ?? "");
        file.ended = [...file.running.slice(0, event.data.nesting), event.data.name].join(" > ");
        break;
      }
      case "test:interrupted":
        // Nothing arrives after this event, and the runner exits after one turn of the event loop.
        // A pipe takes only the first 64 to 128 KiB by then, so what was running comes first.
        yield interruptReport(event.data.tests, progress) + failureReport(failures, output);
        break;
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
      case "test:diagnostic": {
        const { file, level, message, nesting } = event.data;
        const mark = level === "error" ? "✖" : "ℹ";
        if (nesting > 0) {
          // A diagnostic from a test inside a suite or another test: the file name says where it
          // came from.
          const from = file === undefined ? "" : `${relative(process.cwd(), file)}: `;
          notes.push(`${mark} ${from}${message}\n`);
          break;
        }
        // Top-level diagnostics: the counts, coverage floor errors, and warnings such as a
        // test's asynchronous activity after it ended.
        if (level === "info" && COUNT.test(message)) {
          counts.push(message);
        } else {
          notes.push(`${mark} ${message}\n`);
          if (level === "error") rootError = true;
        }
        break;
      }
      case "test:coverage":
        coverage = event;
        break;
    }
  }
  yield failureReport(failures, output);
  if (coverage !== undefined && rootError) yield await coverageTable(coverage);
  yield* notes;
  yield `ℹ ${counts.join(", ")}\n`;
  if (coverage !== undefined) yield `ℹ ${coverageTotals(coverage)}\n`;
}

function progressOf(progress: Map<string, Progress>, file: string): Progress {
  const known = progress.get(file);
  if (known !== undefined) return known;
  const started: Progress = { running: [], ended: undefined };
  progress.set(file, started);
  return started;
}

function failureReport(failures: Failed[], output: string[]): string {
  const parts: string[] = [];
  for (const { path, failure } of failures) {
    parts.push(`\n✖ ${path}${location(failure)}\n`);
    parts.push(`${inspect(failure.details.error, { depth: 6, colors: false })}\n`);
  }
  if (failures.length > 0 && output.length > 0) {
    parts.push(`\n--- captured test output (stdout and stderr) ---\n${output.join("")}`);
  }
  if (failures.length > 0) parts.push("\n");
  return parts.join("");
}

function interruptReport(
  tests: readonly { file?: string | undefined }[],
  progress: Map<string, Progress>,
): string {
  const lines = tests.map(({ file = "" }) => {
    const shown = relative(process.cwd(), file);
    const at = progress.get(file);
    if (at === undefined) return `  ${shown}\n`;
    if (at.ended !== undefined) {
      return `  ${shown}: after ${at.ended}, a hook or the file's teardown (the file did not exit)\n`;
    }
    return `  ${shown}: ${at.running.join(" > ")}\n`;
  });
  return `\nInterrupted while running:\n${lines.join("")}`;
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
