import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  childEnv,
  DOT_OR_EMPTY_SEGMENT,
  extensionDigest,
  hashAll,
  README_TEMPLATE,
  readmePattern,
  SHIPPED_NAME,
  selectShippedFiles,
} from "./build-amo.ts";

export type Level = "INFO" | "WARNING" | "FAIL";
export type Finding = { level: Level; text: string };

/** Every side effect of the checks; file paths are relative to `root` (absolute ones as is). */
export type Env = {
  root: string;
  readFile(file: string): string;
  /** A regular file is there. */
  exists(file: string): boolean;
  readdir(dir: string): string[];
  /** Stdout with one trailing newline removed; anything but exit status 0 throws `CommandError`. */
  sh(command: string, args: readonly string[]): string;
  /** Stdout untouched, for content that is hashed or parsed byte for byte. */
  shBytes(command: string, args: readonly string[]): Buffer;
  /** The local date as YYYY-MM-DD. */
  today(): string;
  /** The current time in milliseconds since the epoch. */
  now(): number;
  /** The names of the tools that `registerTools` in `apps/server/src/tools.ts` registers. */
  listTools(): string[];
};

export type Io = { out(line: string): void; err(line: string): void };
export type Bump = "patch" | "minor" | "major";
export type Command =
  | { name: "changelog" }
  | { name: "listing" }
  | { name: "protocol" }
  | { name: "pre-roll"; bump: Bump | undefined }
  | { name: "post-roll"; version: string }
  | { name: "post-bump"; version: string }
  | { name: "pre-push" }
  | { name: "built"; version: string; dir: string | undefined }
  | { name: "artifacts"; version: string; unsigned: string | undefined }
  | { name: "tag"; tag: string };
export type Usage = { usage: string };
export type CheckResult = Usage | { findings: Finding[] };

export type Entry = { line: number; text: string };
export type ChangeType = { name: string; line: number; entries: Entry[] };
export type Section = {
  line: number;
  header: string;
  version: string | null;
  date: string | null;
  types: ChangeType[];
  body: string;
};
export type Changelog = { preamble: string; sections: Section[]; problems: string[] };
type ValidChangelog = { preamble: string; unreleased: Section; released: Section[] };
type Versions = { version: string | undefined; workspaces: string[] | undefined };
type Archive = { names: string[]; files: string[]; skipped: Set<string> };
type Capability = { listing: string; tools: string[] };
type Evidence = { file: string; contains: string } | { file: string; lacks: string };
type Safeguard = { listing: string; evidence: Evidence[] };
type Claims = { capabilities: Capability[]; safeguards: Safeguard[] };
type Run = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  started: number;
};
type Severity = "info" | "low" | "moderate" | "high" | "critical";
type Advisory = { name: string; severity: Severity; title: string; url: string };
type Published = { at: number; day: string };
type ListedRelease = { version: string; published: Published | undefined };
type NpxPick = { command: string; lo: number; hi: number; release: ListedRelease | undefined };

const SUBCOMMANDS = [
  "changelog",
  "listing",
  "protocol",
  "pre-roll",
  "post-roll",
  "post-bump",
  "pre-push",
  "built",
  "artifacts",
  "tag",
];
const BUMPS: readonly string[] = ["patch", "minor", "major"];
const CHANGE_TYPES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];
// Semver 2.0.0 item 2: no leading zeros, so string equality and git's version sort agree.
const VERSION_CORE = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const VERSION = new RegExp(`^${VERSION_CORE}$`);
const TAG = new RegExp(`^v${VERSION_CORE}$`);
const RELEASE_HEADER = new RegExp(`^## \\[(${VERSION_CORE})\\] - (\\d{4})-(\\d{2})-(\\d{2})$`);
const UNRELEASED_HEADER = "## [Unreleased]";
// CommonMark: up to three spaces of indentation still open a block; a run of = or - makes the
// line above it a heading.
const PREAMBLE_BLOCK = /^ {0,3}(?:#{2,6}(?:[ \t]|$)|```|~~~|(?:=+|-+)[ \t]*$)/;
const INDENTED_HEADING = /^#{1,6}(?:[ \t]|$)/;
const WORKSPACE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*(?:\/\*)?$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SLUG_URL =
  /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/;
const SLUG_PART = /^[\w.-]+$/;
const GH_WORD = /^[a-z_]+$/;
// The line build:amo prints, with the timestamp a GitHub Actions job log puts before each line.
const DIGEST_LINE =
  /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z )?Extension files digest at ([0-9a-f]{40}|[0-9a-f]{64}): sha256:([0-9a-f]{64}) \((\d+) files\)\r?$/;
const ENTRY_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const ARCHIVE_WILDCARD = /[*?[\\]/;
const BREAKING = /breaking[\s-]+changes?/gi;
const NEGATION = /(?:\bno|\bnot a|\bnon-?)\s*$/i;
const ORIGIN_MAIN = "refs/remotes/origin/main";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const SIGNATURE_FILES = ["META-INF/mozilla.rsa", "META-INF/mozilla.sf", "META-INF/manifest.mf"];
const COMMAND_TIMEOUT_MS = 120_000;
const SEVERITIES: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];
// --audit-level=none makes a finished audit exit 0 whatever it finds, so a non-zero exit means it
// failed. --offline=false: npm exits 0 with an empty report, unaudited, when offline is set.
// --workspaces --include-workspace-root: a workspaces setting would otherwise skip packages.
const AUDIT_ARGS = [
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
];
const LISTING = "docs/amo/listing.md";
const CLAIMS = "docs/amo/listing-claims.json";
const MANIFEST = "apps/extension/manifest.json";
const PROTOCOL = "packages/protocol/src/index.ts";
// The published npm package, as apps/server/build.ts names it; the workspace's own name is private.
const NPM_PACKAGE = "foxleash";
const NPM_LISTING = ["view", NPM_PACKAGE, "versions", "time", "dist-tags", "--json"];
// With `name`, every entry has two keys, so npm view does not print the versions alone and drop
// the deprecations.
const NPM_DEPRECATIONS = [
  "view",
  `${NPM_PACKAGE}@>=0.0.0`,
  "name",
  "version",
  "deprecated",
  "--json",
];
const NO_LATEST = `npm has no latest dist-tag for ${NPM_PACKAGE}`;
// ADR 0072: a user whose npm release-age limit is at most this many days still gets a program
// that the add-on serves.
const SERVED_RELEASE_AGE_DAYS = 14;
const DAY_MS = 86_400_000;
const NPM_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const AMO_SOURCE_FILES = "bin/amo-source-files.txt";
const README = "README.md";
const CAPABILITIES_INTRO = "The agent can:";
const SAFEGUARDS_INTRO = "Foxleash limits what a fooled agent can do:";
const PROTECTIONS_INTRO = "What protects you:";
const DATA_INTRO = "The extension declares these kinds of data to Firefox:";
const PERMISSIONS_HEADING = "## Permissions";
const SECTION_CAPS = [
  { heading: "## Summary", max: 250, field: "the add-on's summary" },
  { heading: "## Description", max: 15000, field: "the add-on's description" },
  { heading: PERMISSIONS_HEADING, max: 3000, field: "a version's notes to reviewers" },
];
const DATA_HEADING = "## Data collection and handling";
const AMO_HEADINGS = [...SECTION_CAPS.map((cap) => cap.heading), DATA_HEADING];
const PERMISSION_KEYS = [
  "permissions",
  "host_permissions",
  "optional_permissions",
  "optional_host_permissions",
];
const DATA_KEYS = ["required", "optional"];
// The keys of Extension Workshop's "Firefox built-in consent for data collection and transmission".
const DATA_CATEGORIES = [
  "none",
  "authenticationInfo",
  "bookmarksInfo",
  "browsingActivity",
  "financialAndPaymentInfo",
  "healthInfo",
  "locationInfo",
  "personalCommunications",
  "personallyIdentifyingInfo",
  "searchTerms",
  "technicalAndInteraction",
  "websiteActivity",
  "websiteContent",
];
// `- https://*.example.com/*: ...` names the whole URL pattern, not `https`.
const PERMISSION_BULLET = /^- (\S+):(?: |$)/;
// A CommonMark list item marker, at any indentation.
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const HEADING = /^#{1,6}(?:[ \t]|$)/;
const TRACKED_REGULAR_FILE = /^100(?:644|755) (?:[0-9a-f]{40}|[0-9a-f]{64}) 0\t/;
const LIST_TOOLS_SCRIPT = [
  'import { registerTools } from "./apps/server/src/tools.ts";',
  "const names = [];",
  "registerTools(",
  "  { registerTool(name) { names.push(name); } },",
  '  { call: () => Promise.reject(new Error("no bridge")) },',
  '  { folders: [], cwd: undefined, home: "/nonexistent", log() {} },',
  ");",
  "process.stdout.write(JSON.stringify(names));",
].join("\n");

const USAGE = [
  "usage: npm run check:release -- <subcommand>",
  "  changelog                                CHANGELOG.md has the Keep a Changelog shape",
  "  listing                                  the manifest, the AMO listing and the tools agree",
  "  protocol                                 the extension serves the latest release's server",
  "  pre-roll [--bump=patch|minor|major]      main is synced, clean and green; the next version",
  "  post-roll <version>                      the Unreleased entries moved to <version>",
  "  post-bump <version>                      every version field is <version>",
  "  pre-push                                 the release commits, the tag and the artifacts",
  "  built <version> [--dir <path>]           the source archive is the tagged commit's, the XPI is CI's build of it",
  "  artifacts <version> [--unsigned <path>]  the signed XPI holds the unsigned XPI's files",
  "  tag <tag>                                the tag is v<version>, HEAD is its commit, and the commit is on origin/main",
  "exit status: 0 ok, 1 a check failed, 2 usage error, 3 a warning needs confirmation",
];

/** Parses the arguments, runs one subcommand and prints its findings; returns the exit status. */
export function runCli(argv: readonly string[], env: Env, io: Io): number {
  const command = parseArgs(argv);
  if ("usage" in command) return usageError(command.usage, io);
  const result = runCommand(command, env);
  if ("usage" in result) return usageError(result.usage, io);
  for (const finding of result.findings) {
    io.out(`${finding.level}: ${escapeControls(finding.text)}`);
  }
  const status = exitStatus(result.findings);
  const verdict = status === 0 ? "ok" : status === 1 ? "failed" : "needs confirmation";
  io.out(`check-release: ${command.name} ${verdict}`);
  return status;
}

export function parseArgs(argv: readonly string[]): Command | Usage {
  const [name, ...rest] = argv;
  if (name === undefined) return { usage: "no subcommand given" };
  if (!SUBCOMMANDS.includes(name)) return { usage: `unknown subcommand ${JSON.stringify(name)}` };
  let bump: Bump | undefined;
  let unsigned: string | undefined;
  let dir: string | undefined;
  const positionals: string[] = [];
  const queue = [...rest];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (name === "pre-roll" && arg.startsWith("--bump=")) {
      if (bump !== undefined) return { usage: "--bump is given twice" };
      const value = arg.slice("--bump=".length);
      if (!isBump(value)) {
        return { usage: `--bump must be patch, minor or major, not ${JSON.stringify(value)}` };
      }
      bump = value;
    } else if (name === "artifacts" && arg === "--unsigned") {
      if (unsigned !== undefined) return { usage: "--unsigned is given twice" };
      const value = queue.shift();
      if (value === undefined || value === "") return { usage: "--unsigned needs a path" };
      unsigned = value;
    } else if (name === "built" && arg === "--dir") {
      if (dir !== undefined) return { usage: "--dir is given twice" };
      const value = queue.shift();
      if (value === undefined || value === "") return { usage: "--dir needs a path" };
      dir = value;
    } else if (arg.startsWith("-")) {
      return { usage: `unknown option ${JSON.stringify(arg)} for ${name}` };
    } else {
      positionals.push(arg);
    }
  }
  if (name === "post-roll" || name === "post-bump" || name === "built" || name === "artifacts") {
    const [version, extra] = positionals;
    if (version === undefined) return { usage: `${name} needs a <version>` };
    if (extra !== undefined) return { usage: `unexpected argument ${JSON.stringify(extra)}` };
    if (!VERSION.test(version)) {
      return { usage: `malformed version ${JSON.stringify(version)}: expected x.y.z` };
    }
    if (name === "built") return { name, version, dir };
    if (name === "artifacts") return { name, version, unsigned };
    return { name, version };
  }
  if (name === "tag") {
    const [tag, extra] = positionals;
    if (tag === undefined) return { usage: "tag needs a <tag>" };
    if (extra !== undefined) return { usage: `unexpected argument ${JSON.stringify(extra)}` };
    return { name, tag };
  }
  const [extra] = positionals;
  if (extra !== undefined) return { usage: `unexpected argument ${JSON.stringify(extra)}` };
  if (name === "pre-roll") return { name, bump };
  if (name === "pre-push") return { name };
  if (name === "listing") return { name };
  if (name === "protocol") return { name };
  return { name: "changelog" };
}

function isBump(value: string): value is Bump {
  return BUMPS.includes(value);
}

function usageError(problem: string, io: Io): number {
  io.err(`check-release: ${escapeControls(problem)}`);
  for (const line of USAGE) io.err(line);
  return 2;
}

function runCommand(command: Command, env: Env): CheckResult {
  switch (command.name) {
    case "changelog":
      return { findings: checkChangelog(env) };
    case "listing":
      return { findings: checkListing(env) };
    case "protocol":
      return { findings: checkProtocol(env) };
    case "pre-roll":
      return checkPreRoll(env, command.bump);
    case "post-roll":
      return { findings: checkPostRoll(env, command.version) };
    case "post-bump":
      return { findings: checkPostBump(env, command.version) };
    case "pre-push":
      return { findings: checkPrePush(env) };
    case "built":
      return { findings: checkBuilt(env, command.version, command.dir) };
    case "artifacts":
      return { findings: checkArtifacts(env, command.version, command.unsigned) };
    case "tag":
      return { findings: checkTag(env, command.tag) };
  }
}

/**
 * Replaces every character that could end a line or move the cursor (C0, DEL, C1, the Unicode
 * line and paragraph separators, the bidi controls and marks) with a `\uXXXX` escape, so a
 * value from a file or a command can never print a line of its own.
 */
export function escapeControls(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const control =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    result += control ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return result;
}

function exitStatus(findings: readonly Finding[]): number {
  if (findings.some((finding) => finding.level === "FAIL")) return 1;
  if (findings.some((finding) => finding.level === "WARNING")) return 3;
  return 0;
}

export function checkChangelog(env: Env): Finding[] {
  const findings: Finding[] = [];
  readChangelog(env, findings);
  return findings;
}

export function checkPreRoll(env: Env, bump: Bump | undefined): CheckResult {
  const findings: Finding[] = [];
  // Read first: whether --bump is missing depends on it, and a usage error runs nothing else.
  const tag = attempt(findings, "latest tag", () => latestTag(env, findings));
  if (typeof tag === "string" && bump === undefined) {
    return { usage: `--bump is required: the previous release is ${tag}` };
  }
  const changelog = readChangelog(env, findings);
  const slug = attempt(findings, "origin URL", () => remoteSlug(env, findings));
  attempt(findings, "fetch", () => fetchMain(env));
  attempt(findings, "branch", () => checkOnBranch(env, "main", findings));
  const head = attempt(findings, "HEAD", () => commitSha(env, "HEAD"));
  if (head !== undefined) {
    attempt(findings, "HEAD and origin/main", () => checkHeadIsOriginMain(env, head, findings));
  }
  attempt(findings, "working tree", () => checkClean(env, findings));
  if (typeof tag === "string") {
    attempt(findings, `tag ${tag} on origin`, () => checkTagOnOrigin(env, tag, findings));
  }
  const { version } = checkVersionSources(env, findings);
  if (version !== undefined) checkReleasedAgree(findings, version, changelog, tag);
  checkReleasedTagged(findings, tag, changelog?.released[0]);
  if (changelog !== undefined && !hasEntries(changelog.unreleased)) {
    findings.push(fail("the Unreleased section of CHANGELOG.md has no entries"));
  }
  const next =
    version === undefined || tag === undefined
      ? undefined
      : nextRelease(findings, version, tag, bump, changelog);
  if (next !== undefined) {
    const nextTag = `v${next}`;
    attempt(findings, `tag ${nextTag}`, () => checkNextTagFree(env, nextTag, findings));
  }
  if (slug !== undefined && head !== undefined) {
    attempt(findings, "CI", () => checkCi(env, slug, head, findings));
  }
  attempt(findings, "npm audit", () => checkAudit(env, findings));
  checkListingAgrees(env, tag, findings);
  checkProtocolServed(env, tag, findings);
  if (tag !== undefined) {
    findings.push(info(tag === null ? "no previous tag: first release" : `previous tag: ${tag}`));
  }
  if (next !== undefined) findings.push(info(`next version: ${next}`));
  return { findings };
}

export function checkListing(env: Env): Finding[] {
  const findings: Finding[] = [];
  const tag = attempt(findings, "latest tag", () => latestTag(env, findings));
  checkListingAgrees(env, tag, findings);
  return findings;
}

/**
 * The listing, the claims file, the manifest and the registered tools agree, and, with a
 * previous tag, the manifest's declarations did not change without the listing. `tag` is
 * undefined when listing the tags failed, which is already a FAIL.
 */
function checkListingAgrees(env: Env, tag: string | null | undefined, findings: Finding[]): void {
  const listing = attempt(findings, "listing text", () => env.readFile(LISTING));
  const claims = readClaims(env, findings);
  const manifest = attempt(findings, "listing manifest", () => readJson(env, MANIFEST));
  const tools = attempt(findings, "registered tools", () => env.listTools());
  const capabilityBullets = bulletList(listing, CAPABILITIES_INTRO, findings);
  const safeguardBullets = bulletList(listing, SAFEGUARDS_INTRO, findings);
  const protectionBullets = bulletList(listing, PROTECTIONS_INTRO, findings);
  if (claims !== undefined) {
    const capabilities = claims.capabilities.map((claim) => claim.listing);
    const safeguards = claims.safeguards.map((claim) => claim.listing);
    if (capabilityBullets !== undefined) {
      checkCapabilitiesListed(capabilityBullets, capabilities, findings);
    }
    if (listing !== undefined) checkClaimsOccur(listing, safeguards, findings);
    checkBulletsClaimed(capabilityBullets ?? [], capabilities, findings);
    checkBulletsClaimed(safeguardBullets ?? [], safeguards, findings);
    checkBulletsClaimed(protectionBullets ?? [], safeguards, findings);
    if (tools !== undefined) checkToolsClaimed(tools, claims.capabilities, findings);
    checkSafeguards(env, claims.safeguards, findings);
  }
  if (listing !== undefined && manifest !== undefined) {
    checkPermissionsExplained(listing, manifest, findings);
  }
  if (listing !== undefined) checkSectionLengths(listing, findings);
  checkListingDrift(env, tag, manifest, listing, findings);
}

function readClaims(env: Env, findings: Finding[]): Claims | undefined {
  const value = attempt(findings, "listing claims", () => readJson(env, CLAIMS));
  if (value === undefined) return undefined;
  const claims = parseClaims(value);
  if (Array.isArray(claims)) {
    for (const problem of claims) findings.push(fail(`${CLAIMS}: ${problem}`));
    return undefined;
  }
  return claims;
}

/** The claims file's content, or its shape problems, each naming the JSON path. */
function parseClaims(value: unknown): Claims | string[] {
  const problems: string[] = [];
  if (!hasExactKeys(value, ["note", "capabilities", "safeguards"], "the top level", problems)) {
    return problems;
  }
  if (typeof value.note !== "string") problems.push("note must be a string");
  const capabilities = arrayAt(value.capabilities, "capabilities", problems).filter(
    (capability, index) => isCapability(capability, `capabilities[${index}]`, problems),
  );
  const safeguards = arrayAt(value.safeguards, "safeguards", problems).filter((safeguard, index) =>
    isSafeguard(safeguard, `safeguards[${index}]`, problems),
  );
  return problems.length > 0 ? problems : { capabilities, safeguards };
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
  where: string,
  problems: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object with ${keys.map(quote).join(", ")}`);
    return false;
  }
  const before = problems.length;
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) problems.push(`${where} has the unknown key ${quote(key)}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) problems.push(`${where} has no ${quote(key)}`);
  }
  return problems.length === before;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function arrayAt(value: unknown, where: string, problems: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  problems.push(`${where} must be an array`);
  return [];
}

function isCapability(value: unknown, where: string, problems: string[]): value is Capability {
  const before = problems.length;
  if (hasExactKeys(value, ["listing", "tools"], where, problems)) {
    checkText(value.listing, `${where}.listing`, problems);
    const { tools } = value;
    if (
      !Array.isArray(tools) ||
      tools.length === 0 ||
      !tools.every((tool) => typeof tool === "string" && tool !== "")
    ) {
      problems.push(`${where}.tools must be a non-empty array of non-empty strings`);
    }
  }
  return problems.length === before;
}

function checkText(value: unknown, where: string, problems: string[]): void {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${where} must be a non-empty string`);
  }
}

function isSafeguard(value: unknown, where: string, problems: string[]): value is Safeguard {
  const before = problems.length;
  if (hasExactKeys(value, ["listing", "evidence"], where, problems)) {
    checkText(value.listing, `${where}.listing`, problems);
    arrayAt(value.evidence, `${where}.evidence`, problems).forEach((entry, index) => {
      checkEvidenceShape(entry, `${where}.evidence[${index}]`, problems);
    });
  }
  return problems.length === before;
}

function checkEvidenceShape(value: unknown, where: string, problems: string[]): void {
  const shape = `${where} needs a string "file" and exactly one of "contains" or "lacks"`;
  if (!isRecord(value)) {
    problems.push(shape);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!["file", "contains", "lacks"].includes(key)) {
      problems.push(`${where} has the unknown key ${quote(key)}`);
    }
  }
  if (Object.hasOwn(value, "contains") === Object.hasOwn(value, "lacks")) problems.push(shape);
  for (const key of ["file", "contains", "lacks"]) {
    if (key === "file" || Object.hasOwn(value, key)) {
      checkText(value[key], `${where}.${key}`, problems);
    }
  }
  const { file } = value;
  if (typeof file === "string" && (path.isAbsolute(file) || DOT_OR_EMPTY_SEGMENT.test(file))) {
    problems.push(`${where}.file must be a relative path inside the checkout`);
  }
}

function bulletList(
  listing: string | undefined,
  intro: string,
  findings: Finding[],
): Entry[] | undefined {
  if (listing === undefined) return undefined;
  const found = listingBullets(listing, intro);
  if (typeof found === "string") {
    findings.push(fail(found));
    return undefined;
  }
  return found;
}

/**
 * The items of the list that follows the first line ending with `intro`, nested ones
 * included, with their 1-based line numbers, or the problem that stops finding them. As in
 * Markdown, a wrapped item's other lines (indented, or unindented right below it) join its text.
 */
export function listingBullets(text: string, intro: string): Entry[] | string {
  const all = text.split(/\r?\n/);
  const start = all.findIndex((line) => line.endsWith(intro));
  if (start === -1) return `${LISTING} has no line ending with ${quote(intro)}`;
  const bullets: Entry[] = [];
  // The bullet that an unindented line continues: none after a blank line.
  let open: Entry | undefined;
  for (const [offset, line] of all.slice(start + 1).entries()) {
    const item = LIST_ITEM.exec(line);
    const continued = /^[ \t]/.test(line) ? bullets.at(-1) : open;
    if (/^[ \t]*$/.test(line)) {
      open = undefined;
    } else if (item !== null) {
      open = { line: start + offset + 2, text: line.slice(item[0].length) };
      bullets.push(open);
    } else if (continued !== undefined && !HEADING.test(line)) {
      continued.text += ` ${line.trim()}`;
    } else {
      break;
    }
  }
  if (bullets.length === 0) return `${LISTING}: no bullet list follows ${quote(intro)}`;
  return bullets;
}

function checkCapabilitiesListed(
  bullets: readonly Entry[],
  strings: readonly string[],
  findings: Finding[],
): void {
  for (const text of strings) {
    if (!bullets.some((bullet) => bullet.text.includes(text))) {
      findings.push(
        fail(
          `${CLAIMS}: the capability ${quote(text)} is in no bullet of the list after ${quote(CAPABILITIES_INTRO)} in ${LISTING}`,
        ),
      );
    }
  }
}

function checkClaimsOccur(listing: string, strings: readonly string[], findings: Finding[]): void {
  // A claim may span a wrapped line.
  const flat = listing.replace(/\s+/g, " ");
  for (const text of strings) {
    if (!flat.includes(text)) {
      findings.push(fail(`${CLAIMS}: ${quote(text)} does not occur in ${LISTING}`));
    }
  }
}

function checkBulletsClaimed(
  bullets: readonly Entry[],
  strings: readonly string[],
  findings: Finding[],
): void {
  for (const bullet of bullets) {
    if (!strings.some((text) => bullet.text.includes(text))) {
      findings.push(
        fail(`${LISTING} line ${bullet.line} ${quote(bullet.text)} has no claim in ${CLAIMS}`),
      );
    }
  }
}

function checkToolsClaimed(
  tools: readonly string[],
  capabilities: readonly Capability[],
  findings: Finding[],
): void {
  const registered = new Set(tools);
  const claimed = new Set(capabilities.flatMap((capability) => capability.tools));
  for (const name of [...registered].filter((tool) => !claimed.has(tool)).sort()) {
    findings.push(
      fail(
        `the server registers the tool ${quote(name)}, which no capability in ${CLAIMS} lists: add it there, and describe a new capability in ${LISTING}`,
      ),
    );
  }
  for (const name of [...claimed].filter((tool) => !registered.has(tool)).sort()) {
    findings.push(
      fail(
        `${CLAIMS} lists the tool ${quote(name)}, which the server does not register: build it, or remove it from the claims file and the capability from ${LISTING}`,
      ),
    );
  }
}

function checkSafeguards(env: Env, safeguards: readonly Safeguard[], findings: Finding[]): void {
  for (const safeguard of safeguards) {
    const name = `safeguard ${quote(safeguard.listing)}`;
    if (safeguard.evidence.length === 0) {
      findings.push(fail(`${name} has no evidence in the build yet`));
    }
    for (const evidence of safeguard.evidence) {
      attempt(findings, name, () => checkEvidence(env, name, evidence, findings));
    }
  }
}

function checkEvidence(env: Env, name: string, evidence: Evidence, findings: Finding[]): void {
  const { file } = evidence;
  if (!isTrackedRegularFile(env, file)) {
    findings.push(fail(`${name}: ${file} is not a tracked regular file`));
    return;
  }
  const text = env.readFile(file);
  if ("contains" in evidence) {
    if (!text.includes(evidence.contains)) {
      findings.push(fail(`${name}: ${file} does not contain ${quote(evidence.contains)}`));
    }
  } else if (text.includes(evidence.lacks)) {
    findings.push(fail(`${name}: ${file} contains ${quote(evidence.lacks)}, which it must not`));
  }
}

/** A symlink (mode 120000) could point the read outside the checkout. */
function isTrackedRegularFile(env: Env, file: string): boolean {
  const entries = env.sh("git", ["ls-files", "-s", "-z", "--", file]).split("\0");
  const tracked = entries.some((entry) => {
    const match = TRACKED_REGULAR_FILE.exec(entry);
    return match !== null && entry.slice(match[0].length) === file;
  });
  return tracked && env.exists(file);
}

function checkPermissionsExplained(listing: string, manifest: unknown, findings: Finding[]): void {
  const requested: string[] = [];
  for (const key of PERMISSION_KEYS) {
    requested.push(...stringList(field(manifest, key), key, findings));
  }
  const declared: string[] = [];
  const data = dataCollection(manifest);
  for (const key of DATA_KEYS) {
    const where = `browser_specific_settings.gecko.data_collection_permissions.${key}`;
    declared.push(...stringList(field(data, key), where, findings));
  }
  const all = listing.split(/\r?\n/);
  const permissions = sectionLines(all, PERMISSIONS_HEADING, findings);
  if (permissions !== undefined) {
    const explained = new Map<string, number>();
    for (const line of permissions) {
      const name = PERMISSION_BULLET.exec(line.text)?.[1];
      if (name !== undefined && !explained.has(name)) explained.set(name, line.line);
    }
    for (const name of requested) {
      if (!explained.has(name)) {
        findings.push(
          fail(
            `the manifest requests ${quote(name)}, but the Permissions section of ${LISTING} has no ${quote(`- ${name}:`)} bullet`,
          ),
        );
      }
    }
    for (const [name, line] of explained) {
      if (!requested.includes(name)) {
        findings.push(
          fail(
            `${LISTING} line ${line} explains the permission ${quote(name)}, which the manifest does not request`,
          ),
        );
      }
    }
  }
  checkCategoriesListed(all, declared, findings);
}

function checkCategoriesListed(
  all: readonly string[],
  declared: readonly string[],
  findings: Finding[],
): void {
  const section = sectionLines(all, DATA_HEADING, findings);
  if (section === undefined) return;
  const bullets = listingBullets(section.map((line) => line.text).join("\n"), DATA_INTRO);
  if (typeof bullets === "string") {
    findings.push(
      fail(bullets.replace(LISTING, `the Data collection and handling section of ${LISTING}`)),
    );
    return;
  }
  for (const name of declared) {
    if (!bullets.some((bullet) => bullet.text.includes(`(${name})`))) {
      findings.push(
        fail(
          `the manifest declares the data collection category ${quote(name)}, but the list after ${quote(DATA_INTRO)} in the Data collection and handling section of ${LISTING} does not name it as ${quote(`(${name})`)}`,
        ),
      );
    }
  }
  const named = new Map<string, number>();
  for (const bullet of bullets) {
    // The bullet's line counts within the section; the listing's own line number is the entry's.
    const line = section[bullet.line - 1]?.line ?? bullet.line;
    for (const [found] of bullet.text.matchAll(/\([A-Za-z]+\)/g)) {
      const key = found.slice(1, -1);
      if (DATA_CATEGORIES.includes(key) && !named.has(key)) named.set(key, line);
    }
  }
  for (const [key, line] of named) {
    if (!declared.includes(key)) {
      findings.push(
        fail(
          `${LISTING} line ${line} names the data collection category ${quote(key)}, which the manifest does not declare`,
        ),
      );
    }
  }
}

function dataCollection(manifest: unknown): unknown {
  const gecko = field(field(manifest, "browser_specific_settings"), "gecko");
  return field(gecko, "data_collection_permissions");
}

/** An absent value is empty; a value of another shape is a FAIL and is not used. */
function stringList(value: unknown, key: string, findings: Finding[]): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  findings.push(fail(`${MANIFEST}: ${key} must be absent or an array of strings`));
  return [];
}

/** The lines after `heading` up to the next `## ` heading, numbered from 1. */
function sectionLines(
  all: readonly string[],
  heading: string,
  findings: Finding[],
): Entry[] | undefined {
  const start = all.indexOf(heading);
  if (start === -1) {
    findings.push(fail(`${LISTING} has no ${quote(heading)} section`));
    return undefined;
  }
  const section: Entry[] = [];
  for (const [offset, text] of all.slice(start + 1).entries()) {
    if (text.startsWith("## ")) break;
    section.push({ line: start + offset + 2, text });
  }
  return section;
}

/** Each pasted section fills an AMO field that AMO caps in characters (code points). */
function checkSectionLengths(listing: string, findings: Finding[]): void {
  const all = listing.split(/\r?\n/);
  for (const cap of SECTION_CAPS) {
    // A missing Permissions section is already a FAIL of checkPermissionsExplained.
    const missing = cap.heading === PERMISSIONS_HEADING ? [] : findings;
    const section = sectionLines(all, cap.heading, missing);
    if (section === undefined) continue;
    const length = [...sectionText(section)].length;
    if (length > cap.max) {
      findings.push(
        fail(
          `the ${cap.heading.slice(3)} section of ${LISTING} is ${length} characters, but AMO takes at most ${cap.max} as ${cap.field}: shorten it`,
        ),
      );
    }
  }
}

function sectionText(section: Entry[]): string {
  return section
    .map((line) => line.text)
    .join("\n")
    .trim();
}

function checkListingDrift(
  env: Env,
  tag: string | null | undefined,
  manifest: unknown,
  listing: string | undefined,
  findings: Finding[],
): void {
  if (tag === undefined) return;
  if (tag === null) {
    findings.push(info("no previous tag: drift check skipped"));
    return;
  }
  printDiff(env, tag, MANIFEST, `manifest since ${tag}:`, findings);
  printDiff(env, tag, LISTING, `listing since ${tag}:`, findings);
  printDiff(env, tag, AMO_SOURCE_FILES, `AMO source files since ${tag}:`, findings);
  const tagged = attempt(findings, `${MANIFEST} at ${tag}`, () =>
    parseJson(env.sh("git", ["show", `refs/tags/${tag}:${MANIFEST}`])),
  );
  const taggedListing = attempt(findings, `${LISTING} at ${tag}`, () =>
    env.sh("git", ["show", `refs/tags/${tag}:${LISTING}`]),
  );
  if (taggedListing === undefined) return;
  const taggedSections = amoSections(taggedListing);
  for (const [index, heading] of AMO_HEADINGS.entries()) {
    if (taggedSections[index] === undefined) {
      findings.push(fail(`${LISTING} at ${tag} has no ${quote(heading)} section`));
    }
  }
  if (taggedSections.includes(undefined)) return;
  if (tagged === undefined || manifest === undefined || listing === undefined) return;
  if (!isDeepStrictEqual(taggedSections, amoSections(listing))) return;
  const before = declarations(tagged);
  const now = declarations(manifest);
  const changed = Object.keys(before).filter((name) => !isDeepStrictEqual(before[name], now[name]));
  if (changed.length > 0) {
    findings.push(
      fail(
        `the manifest's ${changed.join(", ")} changed since ${tag}, but the Summary, Description, Permissions and Data collection and handling sections of ${LISTING} did not: update the listing to match`,
      ),
    );
  }
}

/** The text of each AMO section, in AMO_HEADINGS order; undefined for a missing one. */
function amoSections(listing: string): (string | undefined)[] {
  const all = listing.split(/\r?\n/);
  return AMO_HEADINGS.map((heading) => {
    const section = sectionLines(all, heading, []);
    return section === undefined ? undefined : sectionText(section);
  });
}

/** Prints the diff of `file` from `tag` to the working tree. */
function printDiff(env: Env, tag: string, file: string, header: string, findings: Finding[]): void {
  const diff = attempt(findings, `${file} since ${tag}`, () =>
    env.sh("git", [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      `refs/tags/${tag}`,
      "--",
      file,
    ]),
  );
  if (diff === "") {
    findings.push(info(`${header} no change`));
  } else if (diff !== undefined) {
    findings.push(info(header));
    for (const line of lines(diff)) findings.push(info(line));
  }
}

/** The manifest values the listing explains, in FAIL order, with an absent value as empty. */
function declarations(manifest: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of PERMISSION_KEYS) values[key] = field(manifest, key) ?? [];
  const scripts = field(manifest, "content_scripts") ?? [];
  values["content_scripts matches"] = Array.isArray(scripts)
    ? scripts.map((script) => field(script, "matches") ?? [])
    : scripts;
  const data = dataCollection(manifest) ?? {};
  values.data_collection_permissions = isRecord(data)
    ? { ...data, required: field(data, "required") ?? [], optional: field(data, "optional") ?? [] }
    : data;
  values.web_accessible_resources = field(manifest, "web_accessible_resources") ?? [];
  values.externally_connectable = field(manifest, "externally_connectable") ?? {};
  values.content_security_policy = field(manifest, "content_security_policy") ?? {};
  return values;
}

export function checkProtocol(env: Env): Finding[] {
  const findings: Finding[] = [];
  const tag = attempt(findings, "latest tag", () => latestTag(env, findings));
  checkProtocolServed(env, tag, findings);
  return findings;
}

/**
 * The extension serves every protocol from OLDEST_SERVED_PROTOCOL up to PROTOCOL_VERSION, so the
 * oldest may not be above what the latest release shipped: that release's server would stop
 * working at the next add-on update. When the oldest rises above what the latest release served,
 * it may also not pass what any release npx installs under a release-age limit of up to
 * SERVED_RELEASE_AGE_DAYS shipped, the program a user whose limit hides the newer ones gets. `tag`
 * is undefined when listing the tags failed, which is already a FAIL.
 */
function checkProtocolServed(env: Env, tag: string | null | undefined, findings: Finding[]): void {
  const source = attempt(findings, "protocol source", () => env.readFile(PROTOCOL));
  const read = (name: string): number | undefined =>
    source === undefined
      ? undefined
      : attempt(findings, "working tree", () => protocolConstant(source, name));
  const current = read("PROTOCOL_VERSION");
  const oldest = read("OLDEST_SERVED_PROTOCOL");
  const tagSource =
    typeof tag === "string"
      ? attempt(findings, `tag ${tag}`, () =>
          env.sh("git", ["show", `refs/tags/${tag}:${PROTOCOL}`]),
        )
      : undefined;
  const released =
    tagSource === undefined
      ? undefined
      : attempt(findings, `tag ${tag}`, () => protocolConstant(tagSource, "PROTOCOL_VERSION"));
  if (current !== undefined && oldest !== undefined && oldest > current) {
    findings.push(fail(`OLDEST_SERVED_PROTOCOL ${oldest} is above PROTOCOL_VERSION ${current}`));
  }
  if (tag === null) {
    findings.push(info("no previous tag: protocol check against a release skipped"));
  }
  if (released !== undefined) {
    if (current !== undefined && current < released) {
      findings.push(
        fail(
          `PROTOCOL_VERSION ${current} is below the PROTOCOL_VERSION ${released} of ${tag}: the number never goes down`,
        ),
      );
    }
    if (oldest !== undefined && oldest > released) {
      const now = current === undefined ? "" : ` (current ${current})`;
      findings.push(
        fail(
          `OLDEST_SERVED_PROTOCOL ${oldest} is above the PROTOCOL_VERSION ${released} of ${tag}${now}: the extension would not serve the server of ${tag}`,
        ),
      );
    }
  }
  if (current !== undefined && oldest !== undefined) {
    const numbers = `protocol ${current}, oldest served ${oldest}`;
    findings.push(info(released === undefined ? numbers : `${numbers}, ${tag} has ${released}`));
  }
  if (
    typeof tag !== "string" ||
    tagSource === undefined ||
    released === undefined ||
    oldest === undefined ||
    oldest > released
  ) {
    return;
  }
  const tagOldest = attempt(
    findings,
    `tag ${tag}`,
    () => declaredProtocolConstant(tagSource, "OLDEST_SERVED_PROTOCOL") ?? released,
  );
  if (tagOldest !== undefined && oldest > tagOldest) {
    checkServedReleaseAge(env, oldest, tag, tagOldest, findings);
  }
}

/**
 * Like `protocolConstant`, but undefined when no line declares `name`: a tag from before
 * OLDEST_SERVED_PROTOCOL existed served its PROTOCOL_VERSION only.
 */
function declaredProtocolConstant(text: string, name: string): number | undefined {
  return declarationLines(text, name).length === 0 ? undefined : protocolConstant(text, name);
}

/**
 * The number in the line `export const <name> = <number>;` of the protocol source `text`. Every
 * line that declares `name` counts, so a copy in a block comment or a string makes the value
 * ambiguous instead of hiding the real declaration.
 */
function protocolConstant(text: string, name: string): number {
  const declarations = declarationLines(text, name);
  if (declarations.length > 1) {
    throw new Error(`${declarations.length} lines declare ${name} in ${PROTOCOL}: expected one`);
  }
  const match = new RegExp(`^export const ${name} = (0|[1-9]\\d*);$`).exec(declarations[0] ?? "");
  if (match?.[1] === undefined) {
    throw new Error(`no line "export const ${name} = <number>;" in ${PROTOCOL}`);
  }
  return Number(match[1]);
}

function declarationLines(text: string, name: string): string[] {
  return (
    text.match(
      new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${name}\\b.*$`, "gm"),
    ) ?? []
  );
}

/**
 * A user whose npm release-age limit hides the newer releases gets the release npm picks for that
 * limit, so OLDEST_SERVED_PROTOCOL may not pass the lowest PROTOCOL_VERSION among the releases
 * `npx foxleash setup` and `npx foxleash@latest setup` install under any limit up to
 * SERVED_RELEASE_AGE_DAYS (ADR 0072).
 */
function checkServedReleaseAge(
  env: Env,
  oldest: number,
  latestTag: string,
  latestOldest: number,
  findings: Finding[],
): void {
  const listing = attempt(findings, "npm releases", () => npmListing(env));
  if (listing === undefined) return;
  const now = env.now();
  const window = now - SERVED_RELEASE_AGE_DAYS * DAY_MS;
  if (!listing.releases.some((release) => oldEnough(release, window))) {
    findings.push(
      fail(
        `no release has been on npm for ${SERVED_RELEASE_AGE_DAYS} days, so OLDEST_SERVED_PROTOCOL ${oldest} may not rise above the ${latestOldest} that ${latestTag} serves: a user whose npm release-age limit hides the newer releases would get a program the add-on refuses`,
      ),
    );
    return;
  }
  const latest = attempt(findings, "npm releases", () =>
    latestRelease(listing.latest, listing.releases),
  );
  if (latest === undefined) return;
  const deprecated = attempt(findings, "npm releases", () =>
    npmDeprecations(env, listing.releases),
  );
  if (deprecated === undefined) return;
  const tags = attempt(findings, "release tags", () => releaseTags(env).valid);
  if (tags === undefined) return;
  const picks = npxPicks(listing.releases, latest, deprecated, window, now);
  const nothing = picks.find((pick) => pick.release === undefined);
  if (nothing !== undefined) {
    findings.push(
      fail(
        `\`${nothing.command}\` installs nothing under an npm release-age limit of ${limits(nothing)}: no listed release at or below the latest dist-tag ${latest.version} is that old, so OLDEST_SERVED_PROTOCOL ${oldest} may not rise above the ${latestOldest} that ${latestTag} serves`,
      ),
    );
    return;
  }
  const firsts = new Map<string, { pick: NpxPick; release: ListedRelease }>();
  for (const pick of picks) {
    if (pick.release !== undefined && !firsts.has(pick.release.version)) {
      firsts.set(pick.release.version, { pick, release: pick.release });
    }
  }
  const untagged = [...firsts.values()].filter(
    ({ release }) => !tags.includes(`v${release.version}`),
  );
  for (const { pick, release } of untagged) {
    findings.push(
      fail(
        `\`${pick.command}\` installs ${NPM_PACKAGE} ${release.version} under an npm release-age limit of ${limits(pick)}, but no release tag v${release.version} is reachable from HEAD, so its PROTOCOL_VERSION cannot be read`,
      ),
    );
  }
  if (untagged.length > 0) return;
  const measured: { pick: NpxPick; release: ListedRelease; tag: string; protocol: number }[] = [];
  for (const { pick, release } of firsts.values()) {
    const tag = `v${release.version}`;
    const protocol = attempt(findings, `tag ${tag}`, () =>
      protocolConstant(env.sh("git", ["show", `refs/tags/${tag}:${PROTOCOL}`]), "PROTOCOL_VERSION"),
    );
    if (protocol === undefined) return;
    measured.push({ pick, release, tag, protocol });
  }
  const bound = measured.reduce((lowest, next) =>
    next.protocol < lowest.protocol ? next : lowest,
  );
  const published =
    bound.release.published === undefined
      ? "npm has no publish time for it"
      : `published ${bound.release.published.day}`;
  findings.push(
    info(
      `${bound.tag} has the lowest PROTOCOL_VERSION, ${bound.protocol}, of the releases npx installs under an npm release-age limit of up to ${SERVED_RELEASE_AGE_DAYS} days: \`${bound.pick.command}\` installs it under a limit of ${limits(bound.pick)} (${published})`,
    ),
  );
  if (oldest > bound.protocol) {
    findings.push(
      fail(
        `OLDEST_SERVED_PROTOCOL ${oldest} is above the PROTOCOL_VERSION ${bound.protocol} of ${bound.tag}, which \`${bound.pick.command}\` installs under an npm release-age limit of ${limits(bound.pick)} (${published}): a user whose npm release-age limit still hides the newer releases would get a program the add-on refuses`,
      ),
    );
  }
}

/** The x.y.z versions npm lists for the package, with their publish times, and its latest dist-tag. */
function npmListing(env: Env): { latest: unknown; releases: ListedRelease[] } {
  const command = `npm ${NPM_LISTING.join(" ")}`;
  let output: string;
  try {
    output = env.sh("npm", NPM_LISTING);
  } catch (error) {
    // npm view replaces the latest dist-tag with the version it names, which it then cannot find.
    const unlisted =
      error instanceof CommandError ? /No match found for version (\S+)/.exec(error.stderr) : null;
    if (unlisted?.[1] !== undefined) throw new Error(unlistedLatest(unlisted[1]));
    throw error;
  }
  // npm view prints nothing when no version carries the latest dist-tag.
  if (output === "") throw new Error(NO_LATEST);
  let parsed: unknown;
  try {
    parsed = parseJson(output);
  } catch (error) {
    throw new Error(
      `\`${command}\` printed no JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`\`${command}\` printed no JSON object`);
  const versions = field(parsed, "versions");
  if (!Array.isArray(versions) || !versions.every((item) => typeof item === "string")) {
    throw new Error(`\`${command}\` printed no list of versions`);
  }
  const time = field(parsed, "time");
  if (!isRecord(time)) throw new Error(`\`${command}\` printed no publish times`);
  const distTags = field(parsed, "dist-tags");
  if (!isRecord(distTags)) throw new Error(`\`${command}\` printed no dist-tags`);
  const releases = versions
    .filter((version) => VERSION.test(version))
    .map((version) => {
      const value = field(time, version);
      return { version, published: value === undefined ? undefined : publishTime(value, version) };
    });
  return { latest: field(distTags, "latest"), releases };
}

function unlistedLatest(version: string): string {
  return `the latest dist-tag of ${NPM_PACKAGE} names ${version}, which npm does not list in its versions`;
}

/** npm-pick-manifest counts a version with no publish time as old enough. */
function oldEnough(release: ListedRelease, cutoff: number): boolean {
  return release.published === undefined || release.published.at <= cutoff;
}

/** The listed release the latest dist-tag names. */
function latestRelease(latest: unknown, releases: readonly ListedRelease[]): ListedRelease {
  if (typeof latest !== "string") throw new Error(NO_LATEST);
  if (!VERSION.test(latest)) {
    throw new Error(
      `the latest dist-tag of ${NPM_PACKAGE} names ${JSON.stringify(latest)}, not a version x.y.z`,
    );
  }
  const release = releases.find((candidate) => candidate.version === latest);
  if (release === undefined) throw new Error(unlistedLatest(latest));
  return release;
}

/**
 * The listed versions npm marks deprecated. Its output must name exactly the versions of the
 * listing, so a shape npm was not measured printing fails instead of hiding a deprecation.
 */
function npmDeprecations(env: Env, releases: readonly ListedRelease[]): Set<string> {
  const command = `npm ${NPM_DEPRECATIONS.join(" ")}`;
  const output = env.sh("npm", NPM_DEPRECATIONS);
  let parsed: unknown;
  try {
    parsed = parseJson(output);
  } catch (error) {
    throw new Error(
      `\`${command}\` printed no JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // npm view prints one matching version as an object, several as an array.
  const entries: unknown[] | undefined = isRecord(parsed)
    ? [parsed]
    : Array.isArray(parsed)
      ? parsed
      : undefined;
  if (entries === undefined) throw new Error(`\`${command}\` printed no JSON object or array`);
  const versions: string[] = [];
  const deprecated = new Set<string>();
  for (const entry of entries) {
    const version = field(entry, "version");
    if (typeof version !== "string") {
      throw new Error(
        `\`${command}\` printed an entry without a version: ${JSON.stringify(entry)}`,
      );
    }
    const message = field(entry, "deprecated");
    if (message !== undefined && typeof message !== "string") {
      throw new Error(
        `\`${command}\` printed a deprecation of ${version} that is not text: ${JSON.stringify(message)}`,
      );
    }
    versions.push(version);
    // npm-pick-manifest tests `!mani.deprecated`, so an empty message is no deprecation.
    if (message !== undefined && message !== "") deprecated.add(version);
  }
  const listed = releases.map((release) => release.version).toSorted();
  const shown = versions.toSorted();
  if (listed.length !== shown.length || listed.some((version, index) => version !== shown[index])) {
    throw new Error(
      `\`npm ${NPM_LISTING.join(" ")}\` and \`${command}\` list different versions: ${listed.join(", ")} against ${shown.join(", ")}`,
    );
  }
  return deprecated;
}

/**
 * What `npx foxleash setup` and `npx foxleash@latest setup` install at each cutoff where npm's
 * pick can change: the window and every publish inside it, ascending. A pick holds for the limits
 * from the age of the next cutoff at which that command installs another release up to its own
 * cutoff's age. The rules are npm-pick-manifest 11.0.3's (lib/index.js), as npm 11.16.0 ships
 * it; engines are assumed satisfied (ADR 0072).
 */
function npxPicks(
  releases: readonly ListedRelease[],
  latest: ListedRelease,
  deprecated: ReadonlySet<string>,
  window: number,
  now: number,
): NpxPick[] {
  const inside = releases.flatMap(({ published }) =>
    published !== undefined && published.at > window && published.at <= now ? [published.at] : [],
  );
  const cutoffs = [...new Set([window, ...inside])].sort((a, b) => a - b);
  // Lines 151-182: live versions first, then the highest.
  const best = (candidates: readonly ListedRelease[]): ListedRelease | undefined =>
    candidates.toSorted(
      (a, b) =>
        Number(deprecated.has(a.version)) - Number(deprecated.has(b.version)) ||
        compareVersions(b.version, a.version),
    )[0];
  const picks = cutoffs.flatMap((cutoff, index) => {
    const next = cutoffs[index + 1];
    const hi = days(now - cutoff);
    const lo = next === undefined ? 0 : days(now - next);
    const candidates = releases.filter((release) => oldEnough(release, cutoff));
    const old = oldEnough(latest, cutoff);
    // Lines 115-132: the bare name is the range `*`, which takes latest only when it is not
    // deprecated, and otherwise ranks every candidate.
    const bare = old && !deprecated.has(latest.version) ? latest : best(candidates);
    // Lines 97-104: the tag takes latest once it is old enough, else picks from `<=latest`.
    const tagged = old
      ? latest
      : best(candidates.filter((release) => compareVersions(release.version, latest.version) <= 0));
    return [
      { command: `npx ${NPM_PACKAGE} setup`, lo, hi, release: bare },
      { command: `npx ${NPM_PACKAGE}@latest setup`, lo, hi, release: tagged },
    ];
  });
  const merged: NpxPick[] = [];
  const open = new Map<string, NpxPick>();
  for (const pick of picks) {
    const current = open.get(pick.command);
    if (current !== undefined && current.release === pick.release) {
      current.lo = pick.lo;
    } else {
      merged.push(pick);
      open.set(pick.command, pick);
    }
  }
  return merged;
}

/** Whole tenths of a day, rounded down. */
function days(ms: number): number {
  return Math.floor((ms / DAY_MS) * 10) / 10;
}

function limits(pick: NpxPick): string {
  return `${pick.lo} to ${pick.hi} days`;
}

/**
 * An npm publish time such as `2026-11-22T21:23:09.515Z`: the instant and its UTC day. Date.parse
 * rolls a day past the month's end over, so the calendar is checked apart.
 */
function publishTime(value: unknown, version: string): { at: number; day: string } {
  const match = typeof value === "string" ? NPM_TIME.exec(value) : null;
  const at = match === null ? Number.NaN : Date.parse(match[0]);
  if (
    match === null ||
    Number.isNaN(at) ||
    !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
  ) {
    throw new Error(`npm gives no publish time for ${version}: ${JSON.stringify(value)}`);
  }
  return { at, day: match[0].slice(0, 10) };
}

export function checkPostRoll(env: Env, version: string): Finding[] {
  const findings: Finding[] = [];
  const changelog = readChangelog(env, findings);
  if (changelog !== undefined) {
    if (hasEntries(changelog.unreleased)) {
      findings.push(fail("the Unreleased section of CHANGELOG.md is not empty"));
    }
    const expected = `## [${version}] - ${env.today()}`;
    const [top] = changelog.released;
    if (top === undefined) {
      findings.push(fail(`CHANGELOG.md has no released section; expected ${expected}`));
    } else if (top.header !== expected) {
      findings.push(
        fail(
          `CHANGELOG.md:${top.line}: the top released section must read ${expected}, found ${JSON.stringify(top.header)}`,
        ),
      );
    }
  }
  const head =
    changelog === undefined
      ? undefined
      : attempt(findings, "CHANGELOG.md at HEAD", () => compareWithHead(env, changelog, findings));
  const versions = checkVersionSources(env, findings);
  const tag = attempt(findings, "latest tag", () => latestTag(env, findings));
  if (versions.version !== undefined && head !== undefined && typeof tag === "string") {
    checkRolledVersion(findings, version, versions.version, head.unreleased, "HEAD");
  }
  checkReleasedTagged(findings, tag, changelog?.released[1]);
  if (versions.version !== undefined && changelog !== undefined && tag !== undefined) {
    const below = changelog.released[1];
    if (below?.version != null && below.version !== versions.version) {
      findings.push(
        fail(
          `the section below the new one is ${below.version}, expected ${versions.version} (the root package.json version)`,
        ),
      );
    }
    if (tag !== null && tag !== `v${versions.version}`) {
      findings.push(
        fail(
          `the latest tag ${tag} does not match ${versions.version} (the root package.json version)`,
        ),
      );
    }
    if (below === undefined && tag === null && version !== versions.version) {
      findings.push(
        fail(`the first release must be the current version ${versions.version}, not ${version}`),
      );
    }
  }
  attempt(findings, "working tree", () => checkExactChanges(env, [" M CHANGELOG.md"], findings));
  return findings;
}

export function checkPostBump(env: Env, version: string): Finding[] {
  const findings: Finding[] = [];
  const changelog = readChangelog(env, findings);
  const versions = checkVersionSources(env, findings);
  if (versions.version !== undefined && versions.version !== version) {
    findings.push(
      fail(
        `the root package.json version is ${JSON.stringify(versions.version)}, expected ${version}`,
      ),
    );
  }
  const tag = attempt(findings, "latest tag", () => latestTag(env, findings));
  if (changelog !== undefined) {
    const [top, below] = changelog.released;
    checkReleasedTagged(findings, tag, below);
    if (top?.version !== version) {
      findings.push(
        fail(
          `the top released section of CHANGELOG.md is ${top?.version ?? "missing"}, expected ${version}`,
        ),
      );
    }
    if (typeof tag === "string") {
      if (below?.version == null) {
        findings.push(fail(`the latest tag ${tag} has no released section below ${version}`));
      } else if (tag !== `v${below.version}`) {
        findings.push(
          fail(`the latest tag ${tag} does not match the section below, ${below.version}`),
        );
      }
    }
  }
  const { workspaces } = versions;
  if (workspaces !== undefined) {
    attempt(findings, "working tree", () => {
      const before = field(parseJson(env.sh("git", ["show", "HEAD:package.json"])), "version");
      const expected =
        before === version
          ? []
          : [
              "package.json",
              ...workspaces.map((dir) => `${dir}/package.json`),
              "package-lock.json",
            ].map((file) => ` M ${file}`);
      checkExactChanges(env, expected, findings);
    });
  }
  return findings;
}

export function checkPrePush(env: Env): Finding[] {
  const findings: Finding[] = [];
  const changelog = readChangelog(env, findings);
  const { version, workspaces } = checkVersionSources(env, findings);
  const tag = attempt(findings, "latest tag", () => latestTag(env, findings));
  if (changelog !== undefined) {
    if (hasEntries(changelog.unreleased)) {
      findings.push(fail("the Unreleased section of CHANGELOG.md is not empty"));
    }
    if (changelog.released.length === 0) {
      findings.push(fail("CHANGELOG.md has no released section"));
    }
  }
  if (version !== undefined) checkReleasedAgree(findings, version, changelog, tag);
  const slug = attempt(findings, "origin URL", () => remoteSlug(env, findings));
  attempt(findings, "fetch", () => fetchMain(env));
  if (version !== undefined) {
    attempt(findings, "branch", () => checkOnBranch(env, `release/${version}`, findings));
  }
  attempt(findings, "local main", () => {
    const ahead = lines(env.sh("git", ["rev-list", `${ORIGIN_MAIN}..refs/heads/main`]));
    if (ahead.length > 0) {
      findings.push(fail(`local main has commits that origin/main does not: ${ahead.join(", ")}`));
    }
  });
  attempt(findings, "origin/main", () => checkDescendsFromOriginMain(env, findings));
  attempt(findings, "merge commits", () => {
    const merges = lines(env.sh("git", ["rev-list", "--merges", `${ORIGIN_MAIN}..HEAD`]));
    if (merges.length > 0) {
      findings.push(fail(`the commits on top of origin/main include merges: ${merges.join(", ")}`));
    }
  });
  if (version !== undefined) {
    attempt(findings, "release commits", () =>
      checkReleaseCommits(env, version, workspaces, findings),
    );
    const releaseTag = `v${version}`;
    attempt(findings, `tag ${releaseTag}`, () => checkReleaseTag(env, releaseTag, findings));
    attempt(findings, `tag ${releaseTag} on origin`, () => {
      if (remoteTagShas(env, releaseTag).length > 0) {
        findings.push(fail(`the tag ${releaseTag} is already on origin`));
      }
    });
  }
  attempt(findings, "working tree", () => checkClean(env, findings));
  if (version !== undefined) {
    attempt(findings, "artifacts", () => checkBuiltArtifacts(env, version, "artifacts", findings));
  }
  // The release commits are not built by CI before the push: the commit below them must be green.
  const base = attempt(findings, "origin/main sha", () => commitSha(env, ORIGIN_MAIN));
  if (slug !== undefined && base !== undefined) {
    attempt(findings, "CI", () => checkCi(env, slug, base, findings));
  }
  attempt(findings, "npm audit", () => checkAudit(env, findings));
  return findings;
}

/**
 * The artifact checks of `pre-push` for the files in `dir` (default `artifacts`), and the XPI's
 * files against CI's build of the tag's commit.
 */
export function checkBuilt(env: Env, version: string, dir: string | undefined): Finding[] {
  const findings: Finding[] = [];
  const folder = dir === undefined ? "artifacts" : path.resolve(env.root, dir);
  const xpi = attempt(findings, "artifacts", () =>
    checkBuiltArtifacts(env, version, folder, findings),
  );
  if (xpi === undefined) return findings;
  const built = attempt(findings, `${xpi} files digest`, () => xpiDigest(env, xpi, findings));
  if (built === undefined) return findings;
  findings.push(info(`${xpi} files digest: sha256:${built.digest} (${built.count} files)`));
  const slug = attempt(findings, "origin URL", () => remoteSlug(env, findings));
  const tag = `v${version}`;
  const commit = attempt(findings, `commit of ${tag}`, () =>
    commitSha(env, `refs/tags/${tag}^{commit}`),
  );
  if (slug === undefined || commit === undefined) return findings;
  attempt(findings, "CI digest", () =>
    compareWithCi(env, slug, commit, xpi, built.digest, findings),
  );
  return findings;
}

export function checkArtifacts(env: Env, version: string, unsigned: string | undefined): Finding[] {
  const findings: Finding[] = [];
  const signedPath = `web-ext-artifacts/foxleash-${version}.xpi`;
  const unsignedPath =
    unsigned === undefined ? `artifacts/foxleash-${version}.xpi` : path.resolve(env.root, unsigned);
  const usable = [unsignedPath, signedPath].map(
    (file) => attempt(findings, file, () => archiveUsable(env, file, findings)) === true,
  );
  if (!usable.every(Boolean)) return findings;

  const unsignedArchive = attempt(findings, `listing ${unsignedPath}`, () =>
    listArchive(env, unsignedPath, findings),
  );
  const signedArchive = attempt(findings, `listing ${signedPath}`, () =>
    listArchive(env, signedPath, findings),
  );
  if (unsignedArchive === undefined || signedArchive === undefined) return findings;
  for (const name of SIGNATURE_FILES) {
    if (!signedArchive.names.includes(name)) findings.push(fail(`${signedPath} lacks ${name}`));
  }

  const skipped = new Set([...unsignedArchive.skipped, ...signedArchive.skipped]);
  const unsignedFiles = unsignedArchive.files.filter((name) => !skipped.has(name));
  // Case-sensitive on purpose: Firefox reads its signature only from META-INF/.
  const signedFiles = signedArchive.files.filter(
    (name) => !skipped.has(name) && !name.startsWith("META-INF/"),
  );
  const unsignedBytes = readEntries(env, unsignedPath, unsignedFiles, findings);
  const signedBytes = readEntries(env, signedPath, signedFiles, findings);
  const unsignedHashes = hashAll(unsignedBytes);
  const signedHashes = hashAll(signedBytes);

  findings.push(info("entry | unsigned | signed"));
  for (const name of [...new Set([...unsignedFiles, ...signedFiles])].sort()) {
    const unsignedHash = unsignedHashes.get(name);
    const signedHash = signedHashes.get(name);
    findings.push(
      info(`${name} | ${unsignedHash?.slice(0, 12) ?? "-"} | ${signedHash?.slice(0, 12) ?? "-"}`),
    );
    if (!signedFiles.includes(name)) {
      findings.push(fail(`${name} is in the unsigned XPI but not in the signed one`));
    } else if (!unsignedFiles.includes(name)) {
      findings.push(fail(`${name} is in the signed XPI but not in the unsigned one`));
    } else if (
      unsignedHash !== undefined &&
      signedHash !== undefined &&
      unsignedHash !== signedHash
    ) {
      if (name === "manifest.json" && sameJson(unsignedBytes.get(name), signedBytes.get(name))) {
        findings.push(info(`${name} differs only in its JSON formatting`));
      } else {
        findings.push(fail(`${name} differs between the unsigned and the signed XPI`));
      }
    }
  }

  const manifest = signedBytes.get("manifest.json");
  if (manifest === undefined) {
    if (!signedFiles.includes("manifest.json")) {
      findings.push(fail(`${signedPath} has no manifest.json`));
    }
  } else {
    attempt(findings, `${signedPath} manifest.json`, () => {
      checkManifestVersion(manifest, `${signedPath} manifest.json`, version, findings);
    });
  }
  return findings;
}

/** AMO's signed manifest.json can lose its final newline; Firefox reads only the parsed JSON. */
function sameJson(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  try {
    return isDeepStrictEqual(JSON.parse(a.toString("utf8")), JSON.parse(b.toString("utf8")));
  } catch {
    return false;
  }
}

/**
 * The checks before the tag's package is published: the tag is `v` and the version of every
 * version field, HEAD is the tag's commit, and that commit is on origin's main.
 */
export function checkTag(env: Env, tag: string): Finding[] {
  const findings: Finding[] = [];
  const wellFormed = TAG.test(tag);
  if (!wellFormed)
    findings.push(fail(`the tag ${JSON.stringify(tag)} is not a release tag vX.Y.Z`));
  const { version } = checkVersionSources(env, findings);
  if (version !== undefined && tag !== `v${version}`) {
    findings.push(
      fail(`the tag ${JSON.stringify(tag)} is not v${version}, the version of every version field`),
    );
  }
  const head = attempt(findings, "HEAD", () => commitSha(env, "HEAD"));
  // A malformed tag is never handed to git.
  const commit = wellFormed
    ? attempt(findings, `commit of ${tag}`, () => commitSha(env, `refs/tags/${tag}^{commit}`))
    : undefined;
  if (head !== undefined && commit !== undefined && commit !== head) {
    findings.push(fail(`the tag ${tag} is at ${commit}, not at HEAD ${head}`));
  }
  attempt(findings, "fetch", () => fetchMain(env));
  attempt(findings, "origin/main", () => checkOnOriginMain(env, tag, head, findings));
  return findings;
}

/** Runs one check; an exception becomes a FAIL naming the check, and the caller carries on. */
function attempt<T>(findings: Finding[], name: string, check: () => T): T | undefined {
  try {
    return check();
  } catch (error) {
    findings.push(fail(`${name}: ${error instanceof Error ? error.message : String(error)}`));
    return undefined;
  }
}

function fail(text: string): Finding {
  return { level: "FAIL", text };
}

function warning(text: string): Finding {
  return { level: "WARNING", text };
}

function info(text: string): Finding {
  return { level: "INFO", text };
}

/**
 * The highest `v*` tag reachable from HEAD, or null when there is none. Tag names that are not
 * `vX.Y.Z` are a FAIL each and never used.
 */
export function latestTag(env: Env, findings: Finding[]): string | null {
  const { valid, malformed } = releaseTags(env);
  for (const name of malformed) {
    findings.push(fail(`the tag ${JSON.stringify(name)} is not a release tag vX.Y.Z`));
  }
  return valid[0] ?? null;
}

/** The `v*` tags reachable from HEAD: the `vX.Y.Z` ones newest first, and the others. */
function releaseTags(env: Env): { valid: string[]; malformed: string[] } {
  // --no-column: column.ui=always would print several tags on one line.
  const output = env.sh("git", [
    "tag",
    "--list",
    "--no-column",
    "--merged",
    "HEAD",
    "--sort=-v:refname",
    "v*",
  ]);
  const names = lines(output);
  const valid = names
    .filter((name) => TAG.test(name))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  return { valid, malformed: names.filter((name) => !TAG.test(name)) };
}

function lines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** Compares two `x.y.z` versions numerically; negative when `a` is lower. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0n) - (right[index] ?? 0n);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
}

function versionParts(version: string): bigint[] {
  if (!VERSION.test(version)) throw new Error(`not a version x.y.z: ${JSON.stringify(version)}`);
  return version.split(".").map((part) => BigInt(part));
}

/** Reads and shape-checks CHANGELOG.md; returns it only when the shape is valid. */
function readChangelog(env: Env, findings: Finding[]): ValidChangelog | undefined {
  const text = attempt(findings, "CHANGELOG.md", () => env.readFile("CHANGELOG.md"));
  if (text === undefined) return undefined;
  return validChangelog(parseChangelog(text), findings);
}

function validChangelog(changelog: Changelog, findings: Finding[]): ValidChangelog | undefined {
  for (const problem of changelog.problems) findings.push(fail(problem));
  const [unreleased, ...released] = changelog.sections;
  if (changelog.problems.length > 0 || unreleased === undefined) return undefined;
  return { preamble: changelog.preamble, unreleased, released };
}

/** Parses a Keep a Changelog file and lists every way it departs from the shape. */
export function parseChangelog(text: string, name = "CHANGELOG.md"): Changelog {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const start = lines.findIndex((line) => line.startsWith("## "));
  const problems: string[] = [];
  const sections: Section[] = [];
  const problem = (index: number, reason: string): void => {
    problems.push(`${name}:${index + 1}: ${reason}: ${JSON.stringify(lines[index])}`);
  };
  // A renderer sees these structures where this parser sees none: CommonMark also ends a line
  // at a lone CR, and the text above the first section is not parsed.
  const lineBreak = (line: string, index: number): void => {
    if (line.includes("\r")) problem(index, "a carriage return inside the line");
  };
  for (const [index, line] of lines.slice(0, start === -1 ? lines.length : start).entries()) {
    lineBreak(line, index);
    if (PREAMBLE_BLOCK.test(line))
      problem(index, "a heading or code fence above the first ## section");
  }
  if (start === -1) {
    problems.push(`${name} has no ${UNRELEASED_HEADER} section`);
    return { preamble: lines.join("\n"), sections, problems };
  }

  let section: Section | undefined;
  let bodyStart = start;
  let type: ChangeType | undefined;
  let typeIndex = -1;
  let entry: Entry | undefined;
  let lastRelease: string | undefined;

  const closeType = (): void => {
    if (type !== undefined && type.entries.length === 0) {
      problem(type.line - 1, "a change type heading with no entries");
    }
    type = undefined;
    entry = undefined;
  };
  const closeSection = (end: number): void => {
    closeType();
    if (section !== undefined) section.body = lines.slice(bodyStart + 1, end).join("\n");
  };

  for (const [offset, line] of lines.slice(start).entries()) {
    const index = start + offset;
    lineBreak(line, index);
    if (line.startsWith("## ")) {
      closeSection(index);
      section = parseSectionHeader(line, index, sections.length === 0, problem);
      if (section.version !== null) {
        if (lastRelease !== undefined && compareVersions(section.version, lastRelease) >= 0) {
          problem(
            index,
            `version ${section.version} is not below the section above, ${lastRelease}`,
          );
        }
        lastRelease = section.version;
      }
      sections.push(section);
      bodyStart = index;
      typeIndex = -1;
    } else if (line.trim() === "") {
      // Blank lines are allowed anywhere and do not end an entry.
    } else if (line.startsWith("### ")) {
      closeType();
      const typeName = line.slice("### ".length);
      const order = CHANGE_TYPES.indexOf(typeName);
      const current: ChangeType = { name: typeName, line: index + 1, entries: [] };
      type = current;
      if (order === -1) {
        problem(index, `unknown change type; use one of ${CHANGE_TYPES.join(", ")}`);
      } else if (section?.types.some((known) => known.name === typeName)) {
        problem(index, "change type repeated in this section");
      } else if (order < typeIndex) {
        problem(index, `change type out of order; the order is ${CHANGE_TYPES.join(", ")}`);
      } else {
        typeIndex = order;
        section?.types.push(current);
      }
    } else if (line.startsWith("- ")) {
      if (type === undefined) {
        problem(index, "an entry before any ### change type heading");
      } else if (line.slice(2).trim() === "") {
        problem(index, "an empty entry");
        type.entries.push({ line: index + 1, text: "" });
        entry = undefined;
      } else {
        entry = { line: index + 1, text: line.slice(2) };
        type.entries.push(entry);
      }
    } else if (line.startsWith(" ") || line.startsWith("\t")) {
      if (entry === undefined) {
        problem(index, "an indented line with no entry to continue");
      } else if (INDENTED_HEADING.test(line.trim())) {
        problem(index, "a heading indented inside an entry");
      } else {
        entry.text += `\n${line}`;
      }
    } else {
      problem(index, "not a section header, change type heading, entry or continuation line");
    }
  }
  closeSection(lines.length);
  return { preamble: lines.slice(0, start).join("\n"), sections, problems };
}

function parseSectionHeader(
  line: string,
  index: number,
  first: boolean,
  problem: (index: number, reason: string) => void,
): Section {
  const section: Section = {
    line: index + 1,
    header: line,
    version: null,
    date: null,
    types: [],
    body: "",
  };
  if (line === UNRELEASED_HEADER) {
    if (!first) problem(index, `a second ${UNRELEASED_HEADER} section`);
    return section;
  }
  if (first) problem(index, `the first section must be ${UNRELEASED_HEADER}`);
  const match = RELEASE_HEADER.exec(line);
  if (match === null) {
    problem(index, "a section header must read ## [x.y.z] - YYYY-MM-DD");
    return section;
  }
  const [, version = "", year = "", month = "", day = ""] = match;
  if (!isCalendarDate(Number(year), Number(month), Number(day))) {
    problem(index, "not a calendar date");
  }
  section.version = version;
  section.date = `${year}-${month}-${day}`;
  return section;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** The origin repository's `owner/name`, when the fetch and push URLs agree on one. */
function remoteSlug(env: Env, findings: Finding[]): string | undefined {
  const fetchUrl = env.sh("git", ["remote", "get-url", "origin"]);
  const pushUrls = lines(env.sh("git", ["remote", "get-url", "--push", "--all", "origin"]));
  const slug = parseSlug(fetchUrl);
  if (slug === undefined) {
    findings.push(
      fail(`the origin URL ${JSON.stringify(fetchUrl)} is not a github.com repository URL`),
    );
  }
  const [pushUrl, ...extra] = pushUrls;
  if (pushUrl === undefined || extra.length > 0) {
    findings.push(fail(`origin must have exactly one push URL, found ${JSON.stringify(pushUrls)}`));
    return undefined;
  }
  const pushSlug = parseSlug(pushUrl);
  if (pushSlug === undefined) {
    findings.push(
      fail(`the origin push URL ${JSON.stringify(pushUrl)} is not a github.com repository URL`),
    );
    return undefined;
  }
  if (slug === undefined) return undefined;
  if (slug.toLowerCase() !== pushSlug.toLowerCase()) {
    findings.push(
      fail(
        `origin fetches from ${JSON.stringify(fetchUrl)} but pushes to ${JSON.stringify(pushUrl)}`,
      ),
    );
    return undefined;
  }
  return slug;
}

/** `owner/name` from a github.com remote URL, or undefined for any other form. */
export function parseSlug(url: string): string | undefined {
  const match = SLUG_URL.exec(url);
  if (match === null) return undefined;
  const [, owner = "", name = ""] = match;
  for (const part of [owner, name]) {
    if (!SLUG_PART.test(part) || part === "." || part === "..") return undefined;
  }
  return `${owner}/${name}`;
}

function fetchMain(env: Env): void {
  // fetch.pruneTags (and fetch.prune with a tags refspec) would delete the tag a release just
  // made; the explicit refspec makes refs/remotes/origin/main origin's main whatever
  // remote.origin.fetch says.
  env.sh("git", [
    "fetch",
    "--no-prune",
    "--no-prune-tags",
    "origin",
    `+refs/heads/main:${ORIGIN_MAIN}`,
  ]);
}

function checkOnBranch(env: Env, expected: string, findings: Finding[]): void {
  const branch = env.sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") findings.push(fail(`HEAD is detached; check out ${expected}`));
  else if (branch !== expected) {
    findings.push(fail(`on branch ${JSON.stringify(branch)}, not ${expected}`));
  }
}

function commitSha(env: Env, ref: string): string {
  const sha = env.sh("git", ["rev-parse", ref]);
  if (!SHA.test(sha)) throw new Error(`git rev-parse ${ref} printed ${JSON.stringify(sha)}`);
  return sha;
}

// Full ref names throughout: origin/main would resolve refs/tags/origin/main or
// refs/heads/origin/main first.
function checkHeadIsOriginMain(env: Env, head: string, findings: Finding[]): void {
  const originMain = env.sh("git", ["rev-parse", ORIGIN_MAIN]);
  if (originMain === head) return;
  const counts = env.sh("git", ["rev-list", "--left-right", "--count", `${ORIGIN_MAIN}...HEAD`]);
  const match = /^(\d+)\t(\d+)$/.exec(counts);
  const behind = Number(match?.[1] ?? 0);
  const ahead = Number(match?.[2] ?? 0);
  if (ahead > 0 && behind > 0) {
    findings.push(fail(`HEAD and origin/main have diverged: ${ahead} ahead, ${behind} behind`));
  } else if (ahead > 0) {
    findings.push(fail(`HEAD is ${ahead} commit(s) ahead of origin/main; push or reset first`));
  } else if (behind > 0) {
    findings.push(fail(`HEAD is ${behind} commit(s) behind origin/main; pull first`));
  } else {
    findings.push(fail(`HEAD ${head} is not origin/main ${JSON.stringify(originMain)}`));
  }
}

function checkClean(env: Env, findings: Finding[]): void {
  const changes = worktreeChanges(env);
  if (changes.status.length > 0) {
    findings.push(
      fail(
        `the working tree is not clean: ${changes.status.map((line) => JSON.stringify(line)).join(", ")}`,
      ),
    );
  }
  for (const text of changes.hidden) findings.push(fail(text));
}

function checkExactChanges(env: Env, expected: readonly string[], findings: Finding[]): void {
  const changes = worktreeChanges(env);
  const found = [...changes.status].sort();
  const wanted = [...expected].sort();
  if (found.length !== wanted.length || found.some((line, index) => line !== wanted[index])) {
    findings.push(
      fail(
        `git status must list exactly ${JSON.stringify(wanted)}, found ${JSON.stringify(found)}`,
      ),
    );
  }
  for (const text of changes.hidden) findings.push(fail(text));
}

/**
 * The porcelain status lines, plus a text for each file whose changes git status hides
 * (skip-worktree or assume-unchanged). The flags override configuration that hides changes.
 */
export function worktreeChanges(env: Env): { status: string[]; hidden: string[] } {
  const status = lines(
    env.sh("git", ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]),
  );
  const hidden: string[] = [];
  for (const line of lines(env.sh("git", ["ls-files", "-v"]))) {
    const flag = line.slice(0, 1);
    const file = JSON.stringify(line.slice(2));
    if (flag === "S") {
      hidden.push(`${file} is marked skip-worktree, so git status does not show its changes`);
    } else if (/^[a-z]$/.test(flag)) {
      hidden.push(`${file} is marked assume-unchanged, so git status does not show its changes`);
    }
  }
  return { status, hidden };
}

function checkTagOnOrigin(env: Env, tag: string, findings: Finding[]): void {
  const remote = remoteTagShas(env, tag);
  if (remote.length === 0) {
    findings.push(fail(`the latest tag ${tag} is not on origin; push it first`));
    return;
  }
  const local = env.sh("git", ["rev-parse", `refs/tags/${tag}`]);
  if (remote.some((sha) => sha !== local)) {
    findings.push(fail(`the tag ${tag} is ${local} here but ${remote.join(", ")} on origin`));
  }
}

/**
 * The shas origin has for exactly `refs/tags/<tag>`. ls-remote matches a pattern by its tail,
 * so `refs/tags/x/refs/tags/<tag>` would match too.
 */
function remoteTagShas(env: Env, tag: string): string[] {
  const output = env.sh("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  const shas: string[] = [];
  for (const line of lines(output)) {
    const [sha, ref] = line.split("\t");
    if (sha !== undefined && ref === `refs/tags/${tag}`) shas.push(sha);
  }
  return shas;
}

/**
 * Checks that the root, workspace, lockfile and manifest versions agree. Returns the root
 * version when it is a valid `x.y.z`, and the resolved workspace directories.
 */
function checkVersionSources(env: Env, findings: Finding[]): Versions {
  const root = attempt(findings, "package.json", () => readJson(env, "package.json"));
  if (root === undefined) return { version: undefined, workspaces: undefined };
  const rootVersion = field(root, "version");
  let version: string | undefined;
  if (typeof rootVersion !== "string") {
    findings.push(fail("package.json has no version string"));
  } else if (!VERSION.test(rootVersion)) {
    findings.push(fail(`package.json has version ${JSON.stringify(rootVersion)}, not x.y.z`));
  } else {
    version = rootVersion;
  }
  const workspaces = attempt(findings, "workspaces", () =>
    resolveWorkspaces(env, field(root, "workspaces"), findings),
  );
  const expect = (source: string, value: unknown): void => {
    if (typeof value !== "string") findings.push(fail(`${source} has no version string`));
    else if (version !== undefined && value !== version) {
      findings.push(
        fail(
          `${source} has version ${JSON.stringify(value)}, expected ${version} (the root package.json version)`,
        ),
      );
    }
  };
  for (const dir of workspaces ?? []) {
    const file = `${dir}/package.json`;
    attempt(findings, file, () => expect(file, field(readJson(env, file), "version")));
  }
  attempt(findings, "package-lock.json", () => {
    const lock = readJson(env, "package-lock.json");
    const packages = field(lock, "packages");
    expect("package-lock.json version", field(lock, "version"));
    for (const dir of ["", ...(workspaces ?? [])]) {
      expect(
        `package-lock.json packages[${JSON.stringify(dir)}].version`,
        field(field(packages, dir), "version"),
      );
    }
  });
  attempt(findings, "apps/extension/manifest.json", () => {
    const manifest = readJson(env, "apps/extension/manifest.json");
    // The build writes the version from apps/extension/package.json, so none is fine.
    if (isRecord(manifest) && Object.hasOwn(manifest, "version")) {
      expect("apps/extension/manifest.json", manifest.version);
    }
  });
  return { version, workspaces };
}

function readJson(env: Env, file: string): unknown {
  const text = env.readFile(file);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Expands the root `workspaces` (literal paths and `<dir>/*` only) to the sorted directories
 * that hold a package.json. Anything else, which could reach outside the checkout, is a FAIL.
 */
function resolveWorkspaces(env: Env, workspaces: unknown, findings: Finding[]): string[] {
  if (!Array.isArray(workspaces)) {
    findings.push(fail("package.json workspaces is not an array"));
    return [];
  }
  const dirs = new Set<string>();
  for (const entry of workspaces) {
    if (typeof entry !== "string" || !WORKSPACE.test(entry)) {
      findings.push(
        fail(`unsupported workspaces entry ${JSON.stringify(entry)}; use a path or <dir>/*`),
      );
    } else if (entry.endsWith("/*")) {
      const parent = entry.slice(0, -2);
      const found = env
        .readdir(parent)
        .filter((name) => env.exists(`${parent}/${name}/package.json`))
        .map((name) => `${parent}/${name}`);
      if (found.length === 0) findings.push(fail(`workspaces entry ${entry} matches no package`));
      for (const dir of found) dirs.add(dir);
    } else if (env.exists(`${entry}/package.json`)) {
      dirs.add(entry);
    } else {
      findings.push(fail(`workspaces entry ${entry} has no package.json`));
    }
  }
  return [...dirs].sort();
}

function checkReleasedAgree(
  findings: Finding[],
  version: string,
  changelog: ValidChangelog | undefined,
  tag: string | null | undefined,
): void {
  const top = changelog?.released[0];
  if (top?.version != null && top.version !== version) {
    findings.push(
      fail(
        `the top released section of CHANGELOG.md is ${top.version}, expected ${version} (the root package.json version)`,
      ),
    );
  }
  if (typeof tag === "string" && tag !== `v${version}`) {
    findings.push(
      fail(`the latest tag ${tag} does not match ${version} (the root package.json version)`),
    );
  }
}

/** A released section with no `v*` tag reachable from HEAD is a release that was never tagged. */
function checkReleasedTagged(
  findings: Finding[],
  tag: string | null | undefined,
  section: Section | undefined,
): void {
  if (tag === null && section?.version != null) {
    findings.push(
      fail(
        `CHANGELOG.md:${section.line}: ${section.version} is released, but no v* tag is reachable from HEAD`,
      ),
    );
  }
}

/** The shape check guarantees that every change type heading has entries. */
function hasEntries(section: Section): boolean {
  return section.types.length > 0;
}

/** Decides the next version from the previous tag, --bump and the Unreleased changes. */
function nextRelease(
  findings: Finding[],
  version: string,
  tag: string | null,
  bump: Bump | undefined,
  changelog: ValidChangelog | undefined,
): string | undefined {
  if (tag === null) {
    if (bump !== undefined) {
      findings.push(fail(`the first release is the current version ${version}; omit --bump`));
    }
    return version;
  }
  if (bump === undefined || changelog === undefined) return undefined;
  const zeroMajor = versionParts(version)[0] === 0n;
  const types = changelog.unreleased.types.map((type) => type.name);
  const required = minimumBump(version, types);
  if (required !== requiredBump(types)) {
    findings.push(
      info(
        "Removed entries need a major bump, which is minor before 1.0.0; --bump=major releases 1.0.0",
      ),
    );
  }
  const requested = BUMPS.indexOf(bump);
  if (requested < BUMPS.indexOf(required)) {
    findings.push(
      fail(`--bump=${bump} is smaller than the ${required} bump the Unreleased changes need`),
    );
  } else if (requested > BUMPS.indexOf(required)) {
    findings.push(
      warning(`--bump=${bump} is bigger than the ${required} bump the Unreleased changes need`),
    );
  }
  if (requested < BUMPS.indexOf(zeroMajor ? "minor" : "major")) {
    for (const entry of breakingChangeEntries(changelog.unreleased)) {
      findings.push(
        warning(
          `CHANGELOG.md:${entry.line}: the entry mentions a breaking change but --bump=${bump}: ${JSON.stringify(entry.text)}`,
        ),
      );
    }
  }
  return nextVersion(version, bump);
}

/** The rolled version must be what pre-roll allowed: the required bump of V or a bigger one. */
function checkRolledVersion(
  findings: Finding[],
  version: string,
  current: string,
  unreleased: Section,
  source: string,
): void {
  const required = minimumBump(
    current,
    unreleased.types.map((type) => type.name),
  );
  const allowed = BUMPS.slice(BUMPS.indexOf(required))
    .filter(isBump)
    .map((bump) => nextVersion(current, bump));
  if (!allowed.includes(version)) {
    findings.push(
      fail(
        `${version} is not a ${required} bump or bigger from ${current}, which the Unreleased changes at ${source} need: expected ${allowed.join(" or ")}`,
      ),
    );
  }
}

/** The required bump, where semver 2.0.0 item 4 lets anything change while the major is 0. */
function minimumBump(version: string, types: readonly string[]): Bump {
  const required = requiredBump(types);
  return required === "major" && versionParts(version)[0] === 0n ? "minor" : required;
}

/** The smallest bump the change types allow: Removed is major, Added or Deprecated minor. */
export function requiredBump(types: readonly string[]): Bump {
  if (types.includes("Removed")) return "major";
  if (types.includes("Added") || types.includes("Deprecated")) return "minor";
  return "patch";
}

/** The entries that mention a breaking change without negating it, whitespace collapsed. */
export function breakingChangeEntries(section: Section): Entry[] {
  const found: Entry[] = [];
  for (const type of section.types) {
    for (const entry of type.entries) {
      const text = entry.text.replace(/\s+/g, " ").trim();
      const breaking = [...text.matchAll(BREAKING)].some(
        (match) => !NEGATION.test(text.slice(0, match.index)),
      );
      if (breaking) found.push({ line: entry.line, text });
    }
  }
  return found;
}

export function nextVersion(version: string, bump: Bump): string {
  const [major = 0n, minor = 0n, patch = 0n] = versionParts(version);
  if (bump === "major") return `${major + 1n}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1n}.0`;
  return `${major}.${minor}.${patch + 1n}`;
}

function checkNextTagFree(env: Env, tag: string, findings: Finding[]): void {
  if (env.sh("git", ["tag", "--list", tag]) !== "") {
    findings.push(fail(`the tag ${tag} already exists here; delete it with git tag -d ${tag}`));
  }
  if (remoteTagShas(env, tag).length > 0) {
    findings.push(fail(`the tag ${tag} already exists on origin`));
  }
}

/** The newest CI run of ci.yml on main for HEAD must have succeeded. */
function checkCi(env: Env, slug: string, head: string, findings: Finding[]): void {
  const runs = mainCiRuns(
    ghJson(env, `repos/${slug}/actions/runs?head_sha=${head}&per_page=100`),
    slug,
    head,
  );
  const short = head.slice(0, 12);
  if (typeof runs === "string") {
    findings.push(fail(runs));
    return;
  }
  const [newest] = runs.sort((a, b) => b.started - a.started || b.id - a.id);
  if (newest === undefined) {
    findings.push(
      fail(
        `no CI run on main for ${short}; start one with gh workflow run ci.yml --ref main --repo ${slug}, then gh run watch`,
      ),
    );
    return;
  }
  const name = `CI run ${newest.id} (${newest.event})`;
  if (newest.status !== "completed") {
    findings.push(
      fail(
        `${name} for ${short} is still ${newest.status}; wait with gh run watch ${newest.id} --exit-status`,
      ),
    );
  } else if (newest.conclusion === "success") {
    findings.push(info(`${name} green for ${short}`));
  } else if (newest.conclusion === "cancelled") {
    findings.push(
      fail(
        `${name} for ${short} was cancelled; rerun it with gh run rerun ${newest.id}, then gh run watch ${newest.id} --exit-status`,
      ),
    );
  } else {
    findings.push(fail(`${name} for ${short} failed: ${newest.conclusion ?? "no conclusion"}`));
  }
}

/**
 * The runs of this repository's ci.yml on main for `head`, any event: Dependabot's auto-merge
 * starts CI on main with workflow_dispatch. A string is the reason the response is unusable.
 */
export function mainCiRuns(response: unknown, slug: string, head: string): Run[] | string {
  const runs = field(response, "workflow_runs");
  if (!Array.isArray(runs) || !runs.every(isRecord)) {
    return "unexpected gh api response: workflow_runs is not a list of runs";
  }
  const result: Run[] = [];
  for (const run of runs) {
    const repository = field(run.head_repository, "full_name");
    const matches =
      run.name === "CI" &&
      run.path === CI_WORKFLOW &&
      run.head_branch === "main" &&
      run.head_sha === head &&
      typeof repository === "string" &&
      repository.toLowerCase() === slug.toLowerCase();
    if (!matches) continue;
    const { id, event, status, conclusion } = run;
    const started = typeof run.run_started_at === "string" ? Date.parse(run.run_started_at) : NaN;
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      typeof event !== "string" ||
      !GH_WORD.test(event) ||
      typeof status !== "string" ||
      !GH_WORD.test(status) ||
      !(conclusion === null || (typeof conclusion === "string" && GH_WORD.test(conclusion))) ||
      Number.isNaN(started)
    ) {
      return `unexpected gh api response: a CI run for ${head.slice(0, 12)} has unexpected fields`;
    }
    result.push({ id, event, status, conclusion, started });
  }
  return result;
}

/** `npm audit` on the lockfile: each advisory of high or critical severity is a FAIL. */
function checkAudit(env: Env, findings: Finding[]): void {
  const output = env.sh("npm", AUDIT_ARGS);
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    const shown = output.length > 200 ? `${output.slice(0, 200)}...` : output;
    findings.push(fail(`npm audit printed no JSON report: ${quote(shown)}`));
    return;
  }
  const advisories = auditAdvisories(report);
  if (typeof advisories === "string") {
    findings.push(fail(`unexpected npm audit output: ${advisories}`));
    return;
  }
  for (const { name, severity, title, url } of advisories) {
    const text = `npm audit: ${name} has a ${severity} advisory: ${title} ${url}`;
    const blocking = SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf("high");
    findings.push(blocking ? fail(text) : info(text));
  }
  if (advisories.length === 0) findings.push(info("npm audit: no advisories"));
}

/**
 * The advisories of an `npm audit --json` report (version 2), highest severity first and then by
 * package, each once. A package that is vulnerable only through a dependency adds none of its
 * own: that dependency's entry holds the advisory. A string is the reason the report is unusable.
 */
export function auditAdvisories(report: unknown): Advisory[] | string {
  if (!isRecord(report)) return "the report is not an object";
  if (Object.hasOwn(report, "error")) return "the report holds an error";
  if (report.auditReportVersion !== 2) {
    return `auditReportVersion is ${JSON.stringify(report.auditReportVersion)}, not 2`;
  }
  const { vulnerabilities } = report;
  if (!isRecord(vulnerabilities)) return "vulnerabilities is not an object";
  const tally: Record<Severity, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const found = new Map<string, Advisory>();
  for (const [key, entry] of Object.entries(vulnerabilities)) {
    const severity = severityOf(field(entry, "severity"));
    const via = field(entry, "via");
    if (typeof field(entry, "name") !== "string" || severity === undefined || !Array.isArray(via)) {
      return `vulnerabilities.${key} has no name, severity and via list`;
    }
    tally[severity] += 1;
    for (const item of via) {
      if (typeof item === "string") continue;
      const advisory = advisoryOf(item);
      if (advisory === undefined) {
        return `vulnerabilities.${key}.via has an item that is no package name or advisory`;
      }
      found.set(JSON.stringify([advisory.name, advisory.url]), advisory);
    }
  }
  const counts = field(field(report, "metadata"), "vulnerabilities");
  if (!isRecord(counts)) return "metadata.vulnerabilities is not an object";
  for (const severity of SEVERITIES) {
    if (counts[severity] !== tally[severity]) {
      return `metadata.vulnerabilities.${severity} is ${JSON.stringify(counts[severity])}, but the entries hold ${tally[severity]}`;
    }
  }
  const advisories = [...found.values()].sort(
    (a, b) =>
      SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
      a.name.localeCompare(b.name),
  );
  // npm rates an entry by its most severe advisory, its own or a dependency's, so the most severe
  // entry and the most severe advisory agree.
  const entriesUpTo = SEVERITIES.findLast((severity) => tally[severity] > 0) ?? "none";
  const advisoriesUpTo = advisories[0]?.severity ?? "none";
  if (entriesUpTo !== advisoriesUpTo) {
    return `the entries go up to ${entriesUpTo}, but the advisories up to ${advisoriesUpTo}`;
  }
  return advisories;
}

function severityOf(value: unknown): Severity | undefined {
  return SEVERITIES.find((severity) => severity === value);
}

function advisoryOf(value: unknown): Advisory | undefined {
  const name = field(value, "name");
  const severity = severityOf(field(value, "severity"));
  const title = field(value, "title");
  const url = field(value, "url");
  if (
    typeof name !== "string" ||
    severity === undefined ||
    typeof title !== "string" ||
    typeof url !== "string"
  ) {
    return undefined;
  }
  return { name, severity, title, url };
}

function checkDescendsFromOriginMain(env: Env, findings: Finding[]): void {
  try {
    env.sh("git", ["merge-base", "--is-ancestor", ORIGIN_MAIN, "HEAD"]);
  } catch (error) {
    if (!(error instanceof CommandError) || error.status !== 1) throw error;
    findings.push(fail("HEAD does not descend from origin/main; rebase on it first"));
  }
}

function checkOnOriginMain(
  env: Env,
  tag: string,
  sha: string | undefined,
  findings: Finding[],
): void {
  try {
    env.sh("git", ["merge-base", "--is-ancestor", "HEAD", ORIGIN_MAIN]);
  } catch (error) {
    if (!(error instanceof CommandError) || error.status !== 1) throw error;
    findings.push(fail(`the tag ${JSON.stringify(tag)} (${sha ?? "HEAD"}) is not on origin/main`));
  }
}

function checkReleaseCommits(
  env: Env,
  version: string,
  workspaces: readonly string[] | undefined,
  findings: Finding[],
): void {
  // --no-show-signature: log.showSignature would add signature lines to the output.
  const subjects = lines(
    env.sh("git", ["log", "--no-show-signature", "--format=%s", `${ORIGIN_MAIN}..HEAD`]),
  );
  const released = field(
    parseJson(env.sh("git", ["show", `${ORIGIN_MAIN}:package.json`])),
    "version",
  );
  const changelogCommit = `Update changelog for ${version}`;
  const expected =
    released === version ? [changelogCommit] : [`Bump version to ${version}`, changelogCommit];
  if (
    subjects.length !== expected.length ||
    subjects.some((subject, index) => subject !== expected[index])
  ) {
    findings.push(
      fail(
        `the commits on top of origin/main must be ${JSON.stringify(expected)} (newest first), found ${JSON.stringify(subjects)}`,
      ),
    );
  }
  if (workspaces === undefined) return;
  const versionFiles = released === version ? [] : versionFileNames(workspaces);
  checkReleaseChanges(env, version, workspaces, versionFiles, findings);
  if (released !== version) checkReleasedBump(env, version, released, findings);
}

/** The bump on top of origin/main must be what its Unreleased changes allow, as at post-roll. */
function checkReleasedBump(
  env: Env,
  version: string,
  released: unknown,
  findings: Finding[],
): void {
  if (typeof released !== "string" || !VERSION.test(released)) {
    findings.push(
      fail(`${ORIGIN_MAIN}:package.json has version ${JSON.stringify(released)}, not x.y.z`),
    );
    return;
  }
  const text = env.sh("git", ["show", `${ORIGIN_MAIN}:CHANGELOG.md`]);
  const origin = validChangelog(parseChangelog(text, "origin/main:CHANGELOG.md"), findings);
  if (origin !== undefined) {
    checkRolledVersion(findings, version, released, origin.unreleased, "origin/main");
  }
}

function versionFileNames(workspaces: readonly string[]): string[] {
  return ["package.json", ...workspaces.map((dir) => `${dir}/package.json`), "package-lock.json"];
}

/**
 * A subject can name any change, so the content is checked too: only CHANGELOG.md and the
 * version fields may differ from origin/main, which CI has built.
 */
function checkReleaseChanges(
  env: Env,
  version: string,
  workspaces: readonly string[],
  versionFiles: readonly string[],
  findings: Finding[],
): void {
  const changed = lines(
    env.sh("git", ["diff-tree", "-r", "--name-only", "--no-renames", ORIGIN_MAIN, "HEAD"]),
  ).sort();
  const expected = ["CHANGELOG.md", ...versionFiles].sort();
  if (changed.length !== expected.length || changed.some((file, i) => file !== expected[i])) {
    findings.push(
      fail(
        `the release commits must change exactly ${JSON.stringify(expected)}, found ${JSON.stringify(changed)}`,
      ),
    );
  }
  for (const file of versionFiles.filter((name) => changed.includes(name))) {
    const before = env.sh("git", ["show", `${ORIGIN_MAIN}:${file}`]);
    const after = env.sh("git", ["show", `HEAD:${file}`]);
    // The text too: JSON.parse keeps the last of two equal keys, where a bundler reads the first.
    const same =
      onlyVersionLinesDiffer(before, after, version) &&
      isDeepStrictEqual(
        withVersion(parseJson(before), file, version, workspaces),
        parseJson(after),
      );
    if (!same) findings.push(fail(`${file} changes more than its version since origin/main`));
  }
}

/** Every line is unchanged, or a `"version": ...` line whose value became `version`. */
function onlyVersionLinesDiffer(before: string, after: string, version: string): boolean {
  const old = before.split("\n");
  const now = after.split("\n");
  return (
    old.length === now.length &&
    old.every((line, index) => {
      const match = /^(\s*)"version": "[^"\\]*"(,?)$/.exec(line);
      const updated = match && `${match[1]}"version": ${JSON.stringify(version)}${match[2]}`;
      return now[index] === line || now[index] === updated;
    })
  );
}

/** A copy of a version file's JSON with every version field this tool checks set to `version`. */
function withVersion(
  json: unknown,
  file: string,
  version: string,
  workspaces: readonly string[],
): unknown {
  const copy = structuredClone(json);
  const set = (value: unknown): void => {
    if (isRecord(value) && Object.hasOwn(value, "version")) value.version = version;
  };
  set(copy);
  if (file === "package-lock.json") {
    const packages = field(copy, "packages");
    for (const dir of ["", ...workspaces]) set(field(packages, dir));
  }
  return copy;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function checkReleaseTag(env: Env, tag: string, findings: Finding[]): void {
  const tags = lines(env.sh("git", ["tag", "--points-at", "HEAD", "--no-column"]));
  if (tags.length !== 1 || tags[0] !== tag) {
    findings.push(fail(`HEAD must carry exactly the tag ${tag}, found ${JSON.stringify(tags)}`));
  }
  if (!tags.includes(tag)) return;
  const kind = env.sh("git", ["cat-file", "-t", `refs/tags/${tag}`]);
  if (kind !== "tag") {
    findings.push(fail(`the tag ${tag} is not annotated; recreate it with git tag -a ${tag}`));
  }
}

/** Returns the XPI's path when it is there and usable, so a later check can read it. */
function checkBuiltArtifacts(
  env: Env,
  version: string,
  dir: string,
  findings: Finding[],
): string | undefined {
  const source = path.join(dir, `foxleash-source-${version}.zip`);
  const xpi = path.join(dir, `foxleash-${version}.xpi`);
  const [sourcePresent, xpiPresent] = [source, xpi].map((file) => {
    const present = env.exists(file);
    if (!present) findings.push(fail(`${file} is missing; run npm run build:amo`));
    return present;
  });
  const xpiUsable = xpiPresent && archiveUsable(env, xpi, findings);
  if (xpiUsable) {
    attempt(findings, `${xpi} manifest.json`, () => {
      const manifest = env.shBytes("unzip", ["-UU", "-p", xpi, "manifest.json"]);
      checkManifestVersion(manifest, `${xpi} manifest.json`, version, findings);
    });
  }
  if (sourcePresent && archiveUsable(env, source, findings)) {
    attempt(findings, source, () => compareSourceWithTag(env, source, version, findings));
  }
  return xpiUsable ? xpi : undefined;
}

/** The extension files digest of the XPI's file entries; undefined when one could not be read. */
export function xpiDigest(
  env: Env,
  file: string,
  findings: Finding[],
): { digest: string; count: number } | undefined {
  const archive = listArchive(env, file, findings);
  const bytes = readEntries(env, file, archive.files, findings);
  if (archive.skipped.size > 0 || bytes.size !== archive.files.length) return undefined;
  const hashes = hashAll(bytes);
  return { digest: extensionDigest(hashes), count: hashes.size };
}

/**
 * Every digest the successful `validate` jobs of the commit's successful CI runs on main printed
 * must equal the XPI's, and at least one must have been printed.
 */
function compareWithCi(
  env: Env,
  slug: string,
  commit: string,
  xpi: string,
  digest: string,
  findings: Finding[],
): void {
  const short = commit.slice(0, 12);
  const runs = mainCiRuns(
    ghJson(env, `repos/${slug}/actions/runs?head_sha=${commit}&per_page=100`),
    slug,
    commit,
  );
  if (typeof runs === "string") {
    findings.push(fail(runs));
    return;
  }
  const green = runs.filter((run) => run.status === "completed" && run.conclusion === "success");
  const compared: number[] = [];
  for (const run of green) {
    const jobs = attempt(findings, `jobs of CI run ${run.id}`, () =>
      validateJobs(ghJson(env, `repos/${slug}/actions/runs/${run.id}/jobs?per_page=100`)),
    );
    if (jobs === undefined) continue;
    if (typeof jobs === "string") {
      findings.push(fail(`jobs of CI run ${run.id}: ${jobs}`));
      continue;
    }
    const printed = new Set<string>();
    for (const job of jobs) {
      const log = attempt(
        findings,
        `log of job ${job} in CI run ${run.id} (for a log GitHub no longer keeps: gh run rerun ${run.id} within 30 days of the run, a new release after that)`,
        () =>
          env.sh("gh", [
            "api",
            "--hostname",
            "github.com",
            `repos/${slug}/actions/jobs/${job}/logs`,
          ]),
      );
      if (log === undefined) continue;
      for (const each of ciDigests(log, commit)) printed.add(each);
    }
    if (printed.size === 0) continue;
    compared.push(run.id);
    const name = `CI run ${run.id} (${run.event})`;
    const differing = [...printed].filter((each) => each !== digest);
    for (const ci of differing) {
      findings.push(
        fail(
          `${name} printed the extension files digest sha256:${ci} for ${short}, but ${xpi} has sha256:${digest}; do not sign it: it is not the extension CI built`,
        ),
      );
    }
    if (differing.length === 0) {
      findings.push(info(`${name} built the same extension files for ${short}`));
    }
  }
  if (compared.length > 0) return;
  const seen =
    runs.length === 0
      ? ""
      : `; CI runs on main for it: ${runs.map((run) => `${run.id} (${run.status}, ${run.conclusion ?? "no conclusion"})`).join(", ")}`;
  findings.push(
    fail(
      `no successful validate job of a CI run on main for ${short} printed an extension files digest; wait for CI (gh run watch) or rerun it (gh run rerun <run id>)${seen}`,
    ),
  );
}

/** `gh api <endpoint>` parsed as JSON, or undefined when the output is not JSON. */
function ghJson(env: Env, endpoint: string): unknown {
  const output = env.sh("gh", ["api", "--hostname", "github.com", endpoint]);
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

/**
 * The ids of a run's successful `validate` jobs, in the response's order. A string is the reason
 * the response is unusable.
 */
export function validateJobs(response: unknown): number[] | string {
  const jobs = field(response, "jobs");
  if (!Array.isArray(jobs) || !jobs.every(isRecord)) {
    return "unexpected gh api response: jobs is not a list of jobs";
  }
  const ids: number[] = [];
  for (const { id, name, conclusion } of jobs) {
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      typeof name !== "string" ||
      !(conclusion === null || (typeof conclusion === "string" && GH_WORD.test(conclusion)))
    ) {
      return "unexpected gh api response: a job has unexpected fields";
    }
    if (name === "validate" && conclusion === "success") ids.push(id);
  }
  return ids;
}

/** The digests of the log's digest lines for `commit`, in log order. */
export function ciDigests(log: string, commit: string): string[] {
  const digests: string[] = [];
  for (const line of log.split("\n")) {
    const match = DIGEST_LINE.exec(line);
    if (match !== null && match[1] === commit && match[2] !== undefined) digests.push(match[2]);
  }
  return digests;
}

/**
 * The source archive holds exactly the files the tag's commit ships, byte for byte, and a
 * README.md rendered from the commit's template; only its Node and npm versions are free.
 */
function compareSourceWithTag(
  env: Env,
  source: string,
  version: string,
  findings: Finding[],
): void {
  const tag = `v${version}`;
  const sha = commitSha(env, `refs/tags/${tag}^{commit}`);
  const at = `${tag} (${sha.slice(0, 12)})`;
  const shipped = selectShippedFiles(
    env.sh("git", ["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]),
    env.sh("git", ["ls-tree", "-r", "-z", "--full-tree", sha]),
  );
  attempt(findings, `${AMO_SOURCE_FILES} at ${at}`, () =>
    compareRulesWithList(env, sha, at, shipped, findings),
  );
  const archive = listArchive(env, source, findings, SHIPPED_NAME);
  const archived = new Set(archive.files);
  const expected = new Set(shipped);
  for (const name of archive.files
    .filter((each) => each !== README && !expected.has(each))
    .sort()) {
    findings.push(fail(`${source}: ${name} is not a file ${at} ships`));
  }
  if (!archive.skipped.has(README)) {
    if (archived.has(README)) {
      const readme = readEntries(env, source, [README], findings).get(README);
      const template = attempt(findings, `${README_TEMPLATE} at ${at}`, () =>
        env.shBytes("git", ["cat-file", "blob", `${sha}:${README_TEMPLATE}`]).toString("utf8"),
      );
      if (
        readme !== undefined &&
        template !== undefined &&
        !readmePattern(template).test(readme.toString("utf8"))
      ) {
        findings.push(
          fail(
            `${source}: ${README} is not the README of ${at} with a Node and an npm version filled in`,
          ),
        );
      }
    } else {
      findings.push(fail(`${source} lacks ${README}`));
    }
  }
  for (const name of shipped) {
    if (!archived.has(name) && !archive.skipped.has(name)) {
      findings.push(fail(`${source} lacks ${name}, which ${at} ships`));
    }
  }
  const present = shipped.filter((name) => archived.has(name));
  for (const [name, bytes] of readEntries(env, source, present, findings)) {
    const committed = attempt(findings, `${name} at ${at}`, () =>
      env.shBytes("git", ["cat-file", "blob", `${sha}:${name}`]),
    );
    if (committed !== undefined && !bytes.equals(committed)) {
      findings.push(fail(`${source}: ${name} differs from ${at}`));
    }
  }
}

/**
 * `build:amo` made the tag's archive match the tag's list, so a list that disagrees with this
 * checkout's ship rules means the rules changed since the tag and cannot judge its archive.
 */
function compareRulesWithList(
  env: Env,
  sha: string,
  at: string,
  shipped: readonly string[],
  findings: Finding[],
): void {
  const text = env.shBytes("git", ["cat-file", "blob", `${sha}:${AMO_SOURCE_FILES}`]);
  // Parsed as build:amo parses it: one name per line, the last line ending in a newline.
  const names = text.toString("utf8").split("\n");
  if (names.at(-1) === "") names.pop();
  const listed = new Set(names);
  const expected = new Set([...shipped, README]);
  for (const name of [...listed].filter((each) => !expected.has(each)).sort()) {
    findings.push(
      fail(
        `${AMO_SOURCE_FILES} at ${at} lists ${name}, which the ship rules of this checkout do not ship`,
      ),
    );
  }
  for (const name of [...expected].filter((each) => !listed.has(each)).sort()) {
    findings.push(
      fail(
        `${AMO_SOURCE_FILES} at ${at} does not list ${name}, which the ship rules of this checkout ship`,
      ),
    );
  }
}

function checkManifestVersion(
  bytes: Buffer,
  name: string,
  version: string,
  findings: Finding[],
): void {
  const found = field(JSON.parse(bytes.toString("utf8")), "version");
  if (found !== version) {
    findings.push(fail(`${name} has version ${JSON.stringify(found)}, expected ${version}`));
  }
}

/** unzip reads `<path>.zip` for a missing path and expands wildcards in the archive name. */
function archiveUsable(env: Env, file: string, findings: Finding[]): boolean {
  if (ARCHIVE_WILDCARD.test(file)) {
    findings.push(fail(`the archive path ${JSON.stringify(file)} holds a wildcard character`));
    return false;
  }
  if (!env.exists(file)) {
    findings.push(fail(`${file} does not exist`));
    return false;
  }
  return true;
}

/**
 * Lists an archive's entries. A name that could act as an unzip option or pattern, that has a
 * `.`, `..` or empty segment, or that is listed twice, is a FAIL and skipped, so it never
 * becomes an argument.
 */
function listArchive(env: Env, file: string, findings: Finding[], rule = ENTRY_NAME): Archive {
  // -UU: the raw entry names, as Firefox reads them, not an Info-ZIP Unicode Path field.
  const names = lines(env.sh("unzip", ["-Z1", "-UU", file]));
  const skipped = new Set<string>();
  const seen = new Set<string>();
  for (const name of names) {
    // `META-INF/../x` would otherwise escape the comparison as a signature file.
    if (!rule.test(name) || DOT_OR_EMPTY_SEGMENT.test(name)) {
      findings.push(fail(`${file}: unsafe entry name ${JSON.stringify(name)}`));
      skipped.add(name);
    } else if (seen.has(name)) {
      findings.push(fail(`${file}: the entry ${name} is listed twice`));
      skipped.add(name);
    }
    seen.add(name);
  }
  const files = [...seen].filter((name) => !skipped.has(name) && !name.endsWith("/"));
  return { names, files, skipped };
}

function readEntries(
  env: Env,
  file: string,
  names: readonly string[],
  findings: Finding[],
): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (const name of names) {
    const bytes = attempt(findings, `${file} ${name}`, () =>
      env.shBytes("unzip", ["-UU", "-p", file, name]),
    );
    if (bytes !== undefined) entries.set(name, bytes);
  }
  return entries;
}

/**
 * Compares the roll with HEAD: entries moved unchanged, nothing else in the file edited. Returns
 * HEAD's changelog when its shape is valid.
 */
function compareWithHead(
  env: Env,
  changelog: ValidChangelog,
  findings: Finding[],
): ValidChangelog | undefined {
  const headText = env.sh("git", ["show", "HEAD:CHANGELOG.md"]);
  const head = validChangelog(parseChangelog(headText, "HEAD:CHANGELOG.md"), findings);
  if (head === undefined) return undefined;
  if (changelog.preamble !== head.preamble) {
    findings.push(fail("the text above the first section of CHANGELOG.md differs from HEAD"));
  }
  const [top, ...older] = changelog.released;
  if (top !== undefined && top.body.trim() !== head.unreleased.body.trim()) {
    findings.push(
      fail(
        `CHANGELOG.md:${top.line}: the ${JSON.stringify(top.header)} entries differ from the Unreleased entries at HEAD`,
      ),
    );
  }
  if (older.length !== head.released.length) {
    findings.push(
      fail(
        `CHANGELOG.md has ${older.length} sections below the new one, HEAD has ${head.released.length} released sections`,
      ),
    );
    return head;
  }
  older.forEach((section, index) => {
    const before = head.released[index];
    if (before?.header !== section.header || before.body.trim() !== section.body.trim()) {
      findings.push(
        fail(
          `CHANGELOG.md:${section.line}: the section ${JSON.stringify(section.header)} differs from HEAD`,
        ),
      );
    }
  });
  return head;
}

/** A failed command: `status` is null when it was killed by a signal or did not start. */
export class CommandError extends Error {
  command: string;
  status: number | null;
  stderr: string;

  constructor(command: string, status: number | null, stderr: string, cause?: string) {
    super(`\`${command}\` failed (${cause ?? `status ${status}`}): ${stderr.trim()}`);
    this.name = "CommandError";
    this.command = command;
    this.status = status;
    this.stderr = stderr;
  }
}

/** The environment of a real checkout at `root`. */
export function realEnv(root: string): Env {
  return {
    root,
    readFile(file) {
      return readFileSync(path.resolve(root, file), "utf8");
    },
    exists(file) {
      return statSync(path.resolve(root, file), { throwIfNoEntry: false })?.isFile() ?? false;
    },
    readdir(dir) {
      return readdirSync(path.resolve(root, dir));
    },
    sh(command, args) {
      const stdout = spawnChecked(root, command, args).toString("utf8");
      return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    },
    shBytes(command, args) {
      return spawnChecked(root, command, args);
    },
    today() {
      return localDate(new Date());
    },
    now() {
      return Date.now();
    },
    listTools() {
      const args = ["--input-type=module", "-e", LIST_TOOLS_SCRIPT];
      return toolNames(spawnChecked(root, process.execPath, args).toString("utf8"));
    },
  };
}

function spawnChecked(root: string, command: string, args: readonly string[]): Buffer {
  const result = spawnSync(command, args, {
    cwd: root,
    // A stalled network command or a credential prompt becomes a FAIL, not a hang. Replace refs
    // would show the checks other commits than the ones a push sends.
    env: { ...childEnv(process.env), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.status === 0 && result.error === undefined) return result.stdout;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "";
  const cause = result.error
    ? `error ${result.error.message}`
    : result.signal
      ? `signal ${result.signal}`
      : `status ${result.status}`;
  throw new CommandError([command, ...args].join(" "), result.status, stderr, cause);
}

function toolNames(output: string): string[] {
  try {
    const names: unknown = JSON.parse(output);
    if (Array.isArray(names) && names.every((name) => typeof name === "string")) return names;
  } catch {
    // Not JSON: the error below quotes what came back.
  }
  const shown = output.length > 200 ? `${output.slice(0, 200)}...` : output;
  throw new Error(`the tool list is not a JSON array of strings: ${quote(shown)}`);
}

/** YYYY-MM-DD in the local time zone. */
export function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

if (import.meta.main) {
  process.exitCode = runCli(
    process.argv.slice(2),
    realEnv(path.resolve(import.meta.dirname, "..")),
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
  );
}
