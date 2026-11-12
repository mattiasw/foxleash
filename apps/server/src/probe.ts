import { randomUUID } from "node:crypto";
import { lstat, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Params,
  ProbeCheck,
  ProbeCheckName,
  ProbeOutcome,
  ProbeResult,
} from "@foxleash/protocol";
import { Bridge, BridgeError, HostError } from "./bridge.ts";
import { createLog, type Log } from "./log.ts";
import { type PageReport, type ProbeReport, renderJson, renderMarkdown } from "./probe-report.ts";
import { resolveSocketDir } from "./socket-dir.ts";
import { SERVER_VERSION } from "./version.ts";

export interface ProbeOptions {
  /** Already validated as http(s) URLs. */
  urls: string[];
  /** The report path without its extension. */
  out: string | undefined;
  env: NodeJS.ProcessEnv;
  uid: number;
  cwd: string;
  now: () => Date;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface ProbeProcess {
  env: NodeJS.ProcessEnv;
  cwd(): string;
  getuid?: () => number;
}

/** The host's refusals that no later URL can get past. */
const FATAL_CODES: readonly string[] = [
  "extension_disconnected",
  "protocol_mismatch",
  "session_in_use",
  "session_mismatch",
];
/** The question is still open in the tab: the user may answer it yet. */
const RETRIED_CODES: readonly string[] = ["approval_timeout", "settings_write_failed"];
const MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 25;
const MAX_CHECKS = 50;
const MAX_TEXT = 200;

// Records, so a value the protocol adds fails to compile here until it is listed.
const CHECK_NAMES: Record<ProbeCheckName, true> = {
  click_button: true,
  click_link: true,
  type_input: true,
  type_contenteditable: true,
  type_rich_editor: true,
  enter_in_form: true,
  tab_focus: true,
};
const TARGETS: Record<ProbeCheck["target"], true> = { probe: true, site: true };
const OUTCOMES: Record<ProbeOutcome, true> = {
  worked: true,
  no_effect: true,
  no_target: true,
  unknown: true,
  error: true,
};
// The element descriptor the probe builds: tag, type, role, editor kind, up to three classes.
const DESCRIPTOR =
  /^[a-z][a-z0-9-]{0,39}( type=[a-z-]{1,20})?( role=[a-z]{1,20})?( editor=[a-z_]{1,20})?( \.[A-Za-z_-][A-Za-z0-9_-]{0,39}){0,3}$/;

export async function probeCommand(
  options: Pick<ProbeOptions, "urls" | "out" | "stdout" | "stderr">,
  proc: ProbeProcess = process,
): Promise<number> {
  const uid = proc.getuid?.();
  if (uid === undefined) {
    options.stderr.write("foxleash probe runs on Linux only.\n");
    return 1;
  }
  return runProbe({ ...options, env: proc.env, uid, cwd: proc.cwd(), now: () => new Date() });
}

export async function runProbe(options: ProbeOptions): Promise<number> {
  const { urls, out, env, uid, cwd, now, stdout, stderr } = options;
  const date = now();
  const log = createLog("foxleash probe:", stderr);
  const base = path.resolve(cwd, out ?? defaultName(date));
  // Before any tab opens, so the user's answers are not spent on a report with nowhere to go.
  const unusable = await unusableOutput(base);
  if (unusable !== undefined) {
    log(`cannot write the report to ${base}: ${unusable}`);
    return 1;
  }
  const bridge = new Bridge({
    socketDir: resolveSocketDir(env, uid).dir,
    uid,
    version: SERVER_VERSION,
    session: randomUUID(),
    log,
  });
  const pages: PageReport[] = [];
  let userAgent: string | null = null;
  try {
    for (const [index, url] of urls.entries()) {
      const probed = await probeOrRecord(bridge, url, now, log);
      pages.push(probed.page);
      if ("checks" in probed.page) userAgent ??= probed.userAgent ?? null;
      if (probed.openQuestion !== undefined) {
        for (const rest of urls.slice(index + 1)) {
          pages.push({ url: rest, error: notProbed(probed.openQuestion) });
        }
        break;
      }
    }
  } catch (error) {
    if (!isFatal(error)) throw error;
    log(error.message);
    return 1;
  } finally {
    bridge.close();
  }

  const report: ProbeReport = {
    date: date.toISOString(),
    foxleash: SERVER_VERSION,
    userAgent,
    pages,
  };
  try {
    // Never over an existing file: through npm, `--out README` would name the checkout's README.
    await writeFile(`${base}.json`, renderJson(report), { flag: "wx" });
    await writeFile(`${base}.md`, renderMarkdown(report), { flag: "wx" });
  } catch (error) {
    log(`cannot write the report to ${base}`, codeOf(error));
    return 1;
  }
  stdout.write(`${base}.json\n${base}.md\n`);
  return 0;
}

/** Why the report cannot go to `base`: its folder is missing, or a report file exists. */
async function unusableOutput(base: string): Promise<string | undefined> {
  const folder = path.dirname(base);
  const stats = await stat(folder).catch(() => undefined);
  if (stats === undefined || !stats.isDirectory()) return `${folder} is not a folder`;
  for (const file of [`${base}.json`, `${base}.md`]) {
    if ((await lstat(file).catch(() => undefined)) !== undefined) return `${file} already exists`;
  }
  return undefined;
}

interface Probed {
  page: PageReport;
  userAgent?: string;
  /** The tab where Foxleash's question is still open, which blocks every later URL. */
  openQuestion?: number;
}

/** Probes one URL; a refusal from the extension is recorded for it. */
async function probeOrRecord(
  bridge: Bridge,
  url: string,
  now: () => Date,
  log: Log,
): Promise<Probed> {
  try {
    return await probeUrl(bridge, url, now, log);
  } catch (error) {
    if (error instanceof HostError && !FATAL_CODES.includes(error.code)) {
      return { page: errorPage(url, error.code, error.message) };
    }
    throw error;
  }
}

async function probeUrl(bridge: Bridge, url: string, now: () => Date, log: Log): Promise<Probed> {
  log(`opening ${url}; Firefox may ask in the new tab whether to allow its site`);
  const tabId = tabIdOf(await bridge.call("tab_open", {}));
  if (tabId === undefined) {
    return { page: errorPage(url, "invalid_result", "The extension opened no tab with an id.") };
  }
  const start = now().getTime();
  // The report keeps the URL as the user gave it.
  let params: Params<"navigate"> = { tabId, url: new URL(url).href };
  for (let attempt = 1; ; attempt += 1) {
    try {
      await bridge.call("navigate", params);
      break;
    } catch (error) {
      if (!(error instanceof HostError) || !RETRIED_CODES.includes(error.code)) throw error;
      if (attempt >= MAX_ATTEMPTS || now().getTime() - start >= MAX_WAIT_MS) {
        return { page: errorPage(url, error.code, error.message), openQuestion: tabId };
      }
      log(`answer Foxleash's question in tab ${tabId} in Firefox to allow ${originOf(url)}`);
      params = { tabId, action: "reload" };
    }
  }
  const result = parseProbeResult(await callProbe(bridge, tabId));
  if (result === undefined) {
    return {
      page: errorPage(url, "invalid_result", "The extension's probe result is not readable."),
    };
  }
  return { page: { url, checks: result.checks }, userAgent: result.userAgent };
}

async function callProbe(bridge: Bridge, tabId: number): Promise<unknown> {
  try {
    return await bridge.call("probe_input", { tabId });
  } catch (error) {
    // Only an extension older than this command cannot read the request, so no page would do.
    if (error instanceof HostError && error.code === "invalid_request") {
      throw new BridgeError(
        "The Foxleash extension in Firefox is older than this command and cannot run the probe; load the current build.",
        error.code,
      );
    }
    throw error;
  }
}

/** A probe result from the extension, bounded and with only its known fields; else undefined. */
export function parseProbeResult(value: unknown): ProbeResult | undefined {
  if (!isRecord(value) || typeof value.userAgent !== "string" || !Array.isArray(value.checks)) {
    return undefined;
  }
  const checks: ProbeCheck[] = [];
  for (const entry of value.checks.slice(0, MAX_CHECKS)) {
    const check = parseCheck(entry);
    if (check !== undefined) checks.push(check);
  }
  return { userAgent: cut(value.userAgent), checks };
}

function parseCheck(entry: unknown): ProbeCheck | undefined {
  if (!isRecord(entry)) return undefined;
  const { check, target, element, strategy, outcome, delivered, trustedOnly, detail } = entry;
  if (!isCheckName(check) || !isTarget(target) || !isOutcome(outcome)) return undefined;
  if (typeof strategy !== "string" || typeof detail !== "string") return undefined;
  if (typeof delivered !== "boolean" || typeof trustedOnly !== "boolean") return undefined;
  if (element !== undefined && (typeof element !== "string" || !DESCRIPTOR.test(element))) {
    return undefined;
  }
  const parsed: ProbeCheck = {
    check,
    target,
    strategy: cut(strategy),
    outcome,
    delivered,
    trustedOnly,
    detail: cut(detail),
  };
  if (element !== undefined) parsed.element = cut(element);
  return parsed;
}

function tabIdOf(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.tab)) return undefined;
  const { id } = value.tab;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

function errorPage(url: string, code: string, message: string): PageReport {
  return { url, error: { code: cut(code), message: cut(message) } };
}

function notProbed(tabId: number): { code: string; message: string } {
  return {
    code: "not_probed",
    message: `Foxleash's question in tab ${tabId} is still open; answer or close it, then run the probe again.`,
  };
}

function isFatal(error: unknown): error is BridgeError | HostError {
  if (error instanceof BridgeError) return true;
  return error instanceof HostError && FATAL_CODES.includes(error.code);
}

/** `foxleash-probe-YYYYMMDD-HHMMSS`, in local time. */
function defaultName(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `foxleash-probe-${day}-${time}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function codeOf(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/** At most MAX_TEXT code points, so no surrogate pair is split. */
function cut(text: string): string {
  return Array.from(text).slice(0, MAX_TEXT).join("");
}

function isCheckName(value: unknown): value is ProbeCheckName {
  return typeof value === "string" && Object.hasOwn(CHECK_NAMES, value);
}

function isTarget(value: unknown): value is ProbeCheck["target"] {
  return typeof value === "string" && Object.hasOwn(TARGETS, value);
}

function isOutcome(value: unknown): value is ProbeOutcome {
  return typeof value === "string" && Object.hasOwn(OUTCOMES, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
