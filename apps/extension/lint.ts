import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** The fields of a `spawnSync` result that decide whether the lint passed. */
export interface LintRun {
  status: number | null;
  signal: string | null;
  error?: Error;
  stdout?: string | null;
  stderr?: string | null;
}

const ALLOWED_WARNING_CODE = "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION";
const ALLOWED_WARNING_DESCRIPTION =
  /^"strict_min_version" requires Firefox for Android \d+, which was released before version \d+ introduced support for "browser_specific_settings\.gecko\.data_collection_permissions"\.$/;

/** Returns one line per reason the lint run fails the build; an empty list means it passed. */
export function outputFailures(result: LintRun): string[] {
  const failures = reportFailures(result);
  const stderr = (result.stderr ?? "").trim();
  if (failures.length > 0 && stderr !== "") failures.push(`web-ext stderr:\n${stderr}`);
  return failures;
}

function reportFailures(result: LintRun): string[] {
  if (result.error) return [`could not run web-ext lint: ${result.error.message}`];
  const parsed = parseJson(result.stdout ?? "");
  if ("reason" in parsed) return [`web-ext lint did not print a JSON report: ${parsed.reason}`];
  const failures = lintFailures(parsed.value);
  if (failures.length === 0 && result.status !== 0) {
    return [`web-ext lint exited with status ${result.status ?? result.signal}`];
  }
  return failures;
}

function parseJson(text: string): { value: unknown } | { reason: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Returns one line per finding in a parsed web-ext lint report that must fail the build. */
export function lintFailures(report: unknown): string[] {
  if (!isObject(report)) return [unexpectedShape("the report is not an object")];
  const { errors, warnings } = report;
  if (!Array.isArray(errors)) return [unexpectedShape("errors is not an array")];
  if (!Array.isArray(warnings)) return [unexpectedShape("warnings is not an array")];
  return [
    ...errors.map((entry: unknown) => findingLine("error", entry)),
    ...warnings
      .filter((entry: unknown) => !isAllowedWarning(entry))
      .map((entry: unknown) => findingLine("warning", entry)),
  ];
}

function unexpectedShape(part: string): string {
  return `the web-ext lint report is not in the expected shape: ${part}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Without gecko_android, addons-linter checks Firefox for Android against
// gecko.strict_min_version; adding gecko_android to quiet it would make AMO mark Foxhand
// compatible with Firefox for Android.
function isAllowedWarning(entry: unknown): boolean {
  return (
    isObject(entry) &&
    entry.code === ALLOWED_WARNING_CODE &&
    entry.file === "manifest.json" &&
    typeof entry.description === "string" &&
    ALLOWED_WARNING_DESCRIPTION.test(entry.description)
  );
}

function findingLine(kind: string, entry: unknown): string {
  if (!isObject(entry)) return `${kind}: ${JSON.stringify(entry) ?? String(entry)}`;
  const location = `${text(entry.file)}${position(entry.line)}${position(entry.column)}`;
  const line = `${kind} ${text(entry.code)} in ${location}: ${text(entry.message)}`;
  return typeof entry.description === "string" ? `${line} ${entry.description}` : line;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "?";
}

function position(value: unknown): string {
  return typeof value === "number" ? `:${value}` : "";
}

/** Copies `env` without the variables web-ext reads its options from. */
export function lintEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // web-ext takes any option from a variable whose name starts with WEB_EXT (no underscore
  // needed), and from config files unless --no-config-discovery is passed.
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("WEB_EXT")));
}

if (import.meta.main) {
  const result = spawnSync(
    "web-ext",
    [
      "lint",
      "--source-dir",
      join(import.meta.dirname, "dist"),
      "--output",
      "json",
      "--no-config-discovery",
    ],
    {
      env: lintEnv(process.env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const failures = outputFailures(result);
  for (const line of failures) console.error(line);
  if (failures.length > 0) process.exitCode = 1;
}
