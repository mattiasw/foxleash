import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TOOL = "bin/build-amo.ts";
const LIST = "bin/amo-source-files.txt";
export const README_TEMPLATE = "bin/amo-source-readme.md";
// Replace refs would make `git cat-file` return other bytes than the commit holds.
const GIT = ["--no-replace-objects"];
// The archive ships top-level dotfiles, and a leading dot is no unzip option or pattern.
export const SHIPPED_NAME = /^[A-Za-z0-9_.][A-Za-z0-9._/-]*$/;
export const DOT_OR_EMPTY_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)|\/\//;

const TOP_LEVEL_SHIP = new Set([
  ".npmrc",
  ".nvmrc",
  "package-lock.json",
  "package.json",
  "turbo.json",
]);
const TOP_LEVEL_EXCLUDE = new Set([
  ".gitignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "README.md",
  "biome.json",
]);
const EXCLUDED_TREES = ["apps/server/", "e2e/", "docs/", ".github/", ".husky/", "bin/"];
const SHIPPED_TREES = ["apps/extension/", "packages/protocol/", "packages/tsconfig/"];
const EXCLUDED_IN_SHIPPED_TREES = new Set([
  "apps/extension/src/fake-browser.ts",
  "apps/extension/dev.ts",
]);
const LINK_MODES = new Set(["120000", "160000"]);
const ZIP_OPTION_VARIABLES = new Set(["ZIP", "ZIPOPT", "UNZIP", "UNZIPOPT"]);

/**
 * Builds the AMO source zip from HEAD's commit and the XPI rebuilt from it, both in
 * `artifacts/` below `root`.
 */
export async function main(root: string): Promise<void> {
  const amoDist = path.join(root, "amo-dist");
  const artifacts = path.join(root, "artifacts");

  await rm(amoDist, { recursive: true, force: true });
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(amoDist, { recursive: true });

  // Every read is of this one commit, so a commit made during the build cannot mix two.
  const sha = run("git", [...GIT, "rev-parse", "--verify", "HEAD^{commit}"], root).trim();
  const shipped = selectShippedFiles(
    run("git", [...GIT, "ls-tree", "-r", "-z", "--name-only", "--full-tree", sha], root),
    run("git", [...GIT, "ls-tree", "-r", "-z", "--full-tree", sha], root),
  );

  for (const file of shipped) {
    const target = path.join(amoDist, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, runBytes("git", [...GIT, "cat-file", "blob", `${sha}:${file}`], root));
  }
  const template = run("git", [...GIT, "cat-file", "blob", `${sha}:${README_TEMPLATE}`], root);
  // The node and npm on PATH, which run both builds.
  const versions = {
    node: run("node", ["--version"], root).trim().replace(/^v/, ""),
    npm: run("npm", ["--version"], root).trim(),
  };
  await writeFile(path.join(amoDist, "README.md"), renderReadme(template, versions));

  // Outside the checkout, so no parent .git, package.json, node_modules or turbo state leaks in.
  // Both artifacts are written here and reach artifacts/ only once the two builds match.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "foxleash-amo-"));
  try {
    const sourceZip = path.join(tmp, "source.zip");
    // "." rather than "*" so top-level dotfiles are included; -y stores a symlink as one entry.
    run("zip", ["-rqXy", sourceZip, "."], amoDist);
    const clean = path.join(tmp, "clean");
    run("unzip", ["-q", sourceZip, "-d", clean], root);
    assertMatchesList(
      await listFiles(clean),
      run("git", [...GIT, "cat-file", "blob", `${sha}:${LIST}`], root),
    );

    console.log("Building the extension in the checkout");
    run("npm", ["run", "build", "-w", "@foxleash/extension"], root);
    assertNoNodeModulesAbove(await realpath(clean));
    console.log("Installing dependencies in a clean copy of the source archive");
    run("npm", ["ci"], clean);
    console.log("Building the extension in the clean copy");
    run("npm", ["run", "build"], clean);
    console.log("Comparing the two builds");
    const cleanDist = path.join(clean, "apps", "extension", "dist");
    run("diff", ["-r", path.join(root, "apps", "extension", "dist"), cleanDist], root);
    const xpi = path.join(tmp, "extension.xpi");
    run("zip", ["-rqX", xpi, "."], cleanDist);

    const version = await readManifestVersion(cleanDist);
    const sourceName = `foxleash-source-${version}.zip`;
    const xpiName = `foxleash-${version}.xpi`;
    // Both files reach artifacts/ in one rename, so two runs at once cannot leave a mixed pair.
    // A folder below the mkdtemp one, which is 0700, so artifacts/ gets the umask's mode.
    const staged = path.join(await mkdtemp(path.join(amoDist, "artifacts-")), "artifacts");
    await mkdir(staged);
    await copyFile(sourceZip, path.join(staged, sourceName));
    await copyFile(xpi, path.join(staged, xpiName));
    try {
      await rename(staged, artifacts);
    } catch (error) {
      throw new Error(
        `${TOOL}: could not move the artifacts to ${artifacts}, which another run may have written meanwhile`,
        { cause: error },
      );
    }
    console.log(`Source archive: ${path.join(artifacts, sourceName)}`);
    console.log(`Extension built from it: ${path.join(artifacts, xpiName)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  await rm(amoDist, { recursive: true, force: true });
}

/** Runs a command without a shell and returns its stdout; anything but exit status 0 throws. */
export function run(command: string, args: readonly string[], cwd: string): string {
  return runBytes(command, args, cwd).toString("utf8");
}

/** `run`, returning stdout as the bytes the command wrote. */
export function runBytes(command: string, args: readonly string[], cwd: string): Buffer {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  // A child killed by a signal has status null and no error.
  if (result.status === 0) return result.stdout;
  const lines = [`${TOOL}: \`${[command, ...args].join(" ")}\` in ${cwd} failed`];
  lines.push(`status: ${result.status}`);
  if (result.signal) lines.push(`signal: ${result.signal}`);
  if (result.error) lines.push(`error: ${result.error.message}`);
  lines.push(
    `stdout:\n${result.stdout?.toString("utf8") ?? ""}`,
    `stderr:\n${result.stderr?.toString("utf8") ?? ""}`,
  );
  throw new Error(lines.join("\n"));
}

/**
 * Drops what would make the clean build differ from a reviewer's: npm puts the checkout's
 * `node_modules/.bin` folders on PATH, where the clean build would find tools its own install
 * lacks, and zip and unzip take extra options from the environment.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (ZIP_OPTION_VARIABLES.has(name)) continue;
    result[name] =
      name === "PATH" && value !== undefined
        ? value
            .split(path.delimiter)
            .filter((dir) => !dir.split(path.sep).includes("node_modules"))
            .join(path.delimiter)
        : value;
  }
  return result;
}

/**
 * Takes raw `git ls-tree -r -z --name-only` and `git ls-tree -r -z` output of one commit and
 * returns the sorted list of files the archive ships, throwing on a link, then on a shipped path
 * that is not a plain relative name, then on unclassified files.
 */
export function selectShippedFiles(treeZ: string, entriesZ: string): string[] {
  const { ship, unclassified } = partitionTrackedFiles(splitNul(treeZ));
  // A link at a directory is one bare path in the tree, which the partition calls unclassified,
  // so check links first to name it as a link. The template is read from the commit too.
  assertNoTrackedLinks(entriesZ, [...ship, ...unclassified, README_TEMPLATE]);
  const unsafe = ship.filter((file) => !SHIPPED_NAME.test(file) || DOT_OR_EMPTY_SEGMENT.test(file));
  if (unsafe.length > 0) {
    throw new Error(
      [
        `${TOOL}: these shipped paths are not plain relative names (letters, digits, ".", "_", "-" and "/", with no ".", ".." or empty segment):`,
        ...unsafe.map((file) => `  ${JSON.stringify(file)}`),
      ].join("\n"),
    );
  }
  if (unclassified.length > 0) {
    throw new Error(
      [
        `${TOOL}: these tracked files match no ship or exclude rule:`,
        ...unclassified.map((file) => `  ${JSON.stringify(file)}`),
        `Add a ship or exclude rule for them in ${TOOL}.`,
      ].join("\n"),
    );
  }
  return ship;
}

/** Splits tracked paths into the ones the archive ships and the ones no rule covers. */
export function partitionTrackedFiles(paths: readonly string[]): {
  ship: string[];
  unclassified: string[];
} {
  const ship: string[] = [];
  const unclassified: string[] = [];
  for (const file of paths) {
    const kind = classify(file);
    if (kind === "ship") ship.push(file);
    else if (kind === "unclassified") unclassified.push(file);
  }
  return { ship: ship.sort(compareBytes), unclassified };
}

function classify(file: string): "ship" | "exclude" | "unclassified" {
  if (TOP_LEVEL_SHIP.has(file)) return "ship";
  if (TOP_LEVEL_EXCLUDE.has(file)) return "exclude";
  if (EXCLUDED_TREES.some((tree) => file.startsWith(tree))) return "exclude";
  if (!SHIPPED_TREES.some((tree) => file.startsWith(tree))) return "unclassified";
  if (file.endsWith(".test.ts") || EXCLUDED_IN_SHIPPED_TREES.has(file)) return "exclude";
  // Unknown extensions fail closed until they get a rule.
  return /\.(ts|json|svg|html|css)$/.test(file) ? "ship" : "unclassified";
}

function splitNul(text: string): string[] {
  return text.split("\0").filter((item) => item !== "");
}

/**
 * A link in the commit at or above a shipped path would ship its target text in place of the
 * bytes the checkout build reads.
 */
export function assertNoTrackedLinks(entriesZ: string, checked: readonly string[]): void {
  const refused: string[] = [];
  for (const entry of splitNul(entriesZ)) {
    const mode = entry.slice(0, entry.indexOf(" "));
    const file = entry.slice(entry.indexOf("\t") + 1);
    if (!LINK_MODES.has(mode)) continue;
    if (checked.some((each) => each === file || each.startsWith(`${file}/`))) refused.push(file);
  }
  if (refused.length > 0) {
    throw new Error(
      [
        `${TOOL}: these tracked symlinks or submodules are at or above a shipped path:`,
        ...refused.map((file) => `  ${JSON.stringify(file)}`),
        "Copying them would embed bytes this repository does not track.",
      ].join("\n"),
    );
  }
}

/** Fills in the Node and npm versions; a placeholder left over throws. */
export function renderReadme(template: string, versions: { node: string; npm: string }): string {
  const rendered = template
    .replaceAll("{{node}}", () => versions.node)
    .replaceAll("{{npm}}", () => versions.npm);
  const left = rendered.match(/\{\{[^{}]*\}\}/g);
  if (left) {
    throw new Error(`${TOOL}: ${README_TEMPLATE} has unknown placeholders: ${left.join(", ")}`);
  }
  return rendered;
}

/** Matches what `renderReadme` makes of `template` with any `x.y.z` versions, and nothing else. */
export function readmePattern(template: string): RegExp {
  const parts = template
    .split(/\{\{(?:node|npm)\}\}/)
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));
  return new RegExp(`^${parts.join(String.raw`\d+\.\d+\.\d+`)}$`);
}

// withFileTypes, so an unexpected entry type is counted rather than skipped.
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

/** Compares the archive's files with the list text; every difference goes into one error. */
export function assertMatchesList(files: readonly string[], listText: string): void {
  const lines = listText.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const listed = new Set(lines);
  const present = new Set(files);
  const unlisted = files.filter((file) => !listed.has(file)).sort(compareBytes);
  const missing = lines.filter((line) => !present.has(line));
  const unordered = lines.filter(
    (line, index) => index > 0 && compareBytes(lines[index - 1] ?? "", line) >= 0,
  );
  const problems = [
    ...section("In the archive but not listed:", unlisted),
    ...section("Listed but not in the archive:", missing),
    ...section("Listed out of order or twice:", unordered),
  ];
  if (problems.length === 0) return;
  throw new Error(
    [
      `${TOOL}: the archive does not match ${LIST} in HEAD's commit.`,
      ...problems,
      `Fix: edit ${LIST}, one path per line in LC_ALL=C sort order, and commit it.`,
    ].join("\n"),
  );
}

function section(heading: string, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  return [heading, ...files.map((file) => `  ${JSON.stringify(file)}`)];
}

/** Byte order, the order `LC_ALL=C sort` uses. */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Node and esbuild look for a missing package in every folder above, which a reviewer lacks. */
export function assertNoNodeModulesAbove(dir: string): void {
  const found: string[] = [];
  for (let current = path.dirname(dir); ; current = path.dirname(current)) {
    const candidate = path.join(current, "node_modules");
    if (existsSync(candidate)) found.push(candidate);
    if (path.dirname(current) === current) break;
  }
  if (found.length > 0) {
    throw new Error(
      [
        `${TOOL}: the clean copy in ${dir} could load packages from folders above it:`,
        ...found.map((folder) => `  ${folder}`),
        "Set TMPDIR to a folder with no node_modules above it.",
      ].join("\n"),
    );
  }
}

async function readManifestVersion(dist: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
  if (typeof value === "object" && value !== null && "version" in value) {
    const { version } = value;
    if (typeof version === "string" && version !== "") return version;
  }
  throw new Error(`${TOOL}: the built manifest.json has no version string.`);
}

if (import.meta.main) await main(path.resolve(import.meta.dirname, ".."));
