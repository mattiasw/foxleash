import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { build as bundle, type Metafile } from "esbuild";

const root = import.meta.dirname;
const repo = join(root, "..", "..");
export const dist = join(root, "dist");

const LICENSES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"]);
const LICENSE_FILE = /^licen[cs]e(\.(md|txt))?$/i;
// Apache-2.0 section 4(d): a NOTICE file's attributions go with every copy.
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;
const NODE_MODULES = "/node_modules/";
// A package name, scoped or not, followed by a path inside its folder.
const PACKAGE_PATH = /^((?:@[^/]+\/)?[^/@][^/]*)\/./;

/**
 * Writes the npm package into a new `outDir`: the bundled program, its package.json, the license,
 * the README and the notices of the third-party code it contains. A build that esbuild fails, or
 * that refuses a bundled file or package, leaves no `outDir`, so never a package without notices.
 */
export async function build(outDir: string = dist): Promise<Metafile> {
  await rm(outDir, { recursive: true, force: true });
  const { outputFiles, metafile } = await bundle({
    entryPoints: [join(root, "src", "main.ts")],
    outfile: join(outDir, "foxleash.mjs"),
    absWorkingDir: root,
    platform: "node",
    format: "esm",
    target: "node24",
    bundle: true,
    minify: false,
    metafile: true,
    write: false,
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "warning",
  });
  const [program, ...others] = outputFiles;
  if (program === undefined || others.length > 0) {
    throw new Error(`esbuild wrote ${outputFiles.length} files instead of one.`);
  }
  const packages = bundledPackageDirs(Object.keys(metafile.inputs), root, repo);
  const notices = await thirdPartyNotices(packages);
  const manifest = await packageJson();
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(join(outDir, "foxleash.mjs"), program.contents),
    writeFile(join(outDir, "package.json"), manifest),
    copyFile(join(repo, "LICENSE"), join(outDir, "LICENSE")),
    copyFile(join(repo, "README.md"), join(outDir, "README.md")),
    writeFile(join(outDir, "THIRD_PARTY_NOTICES.md"), notices),
  ]);
  return metafile;
}

/**
 * The folders of the packages under node_modules that `inputs` come from, sorted. Throws for an
 * input that is neither in such a package nor workspace code, so no code escapes the notices.
 */
export function bundledPackageDirs(
  inputs: readonly string[],
  workingDir: string,
  repo: string,
): string[] {
  const workspaces = [join(repo, "apps", "server"), join(repo, "packages")].map(
    (dir) => `${resolve(dir)}${sep}`,
  );
  const dirs = new Set<string>();
  for (const input of inputs) {
    const path = resolve(workingDir, input);
    // The last node_modules: a nested package is the innermost one.
    const index = path.lastIndexOf(NODE_MODULES);
    if (index !== -1) {
      const match = PACKAGE_PATH.exec(path.slice(index + NODE_MODULES.length));
      if (match === null) {
        throw new Error(`${input} is in node_modules but in no package folder.`);
      }
      dirs.add(`${path.slice(0, index)}${NODE_MODULES}${match[1]}`);
    } else if (!workspaces.some((workspace) => path.startsWith(workspace))) {
      throw new Error(`${input} is neither in node_modules nor in the workspace.`);
    }
  }
  return [...dirs].sort();
}

/** THIRD_PARTY_NOTICES.md for the packages in `packageDirs`. Throws naming a package it refuses. */
export async function thirdPartyNotices(packageDirs: readonly string[]): Promise<string> {
  const entries = await Promise.all(packageDirs.map((dir) => noticeEntry(dir)));
  entries.sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  const sections = entries.map(
    (entry) =>
      `## ${entry.name} ${entry.version}\n\nLicense: ${entry.license}\n\n${entry.texts.join("\n\n")}\n`,
  );
  return [
    "# Third-party notices\n",
    "foxleash.mjs contains code from the packages below. Each is listed with its version, its license\nand the text of its license file.\n",
    ...sections,
  ].join("\n");
}

interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  texts: string[];
}

async function noticeEntry(dir: string): Promise<NoticeEntry> {
  const manifest = await readJsonObject(join(dir, "package.json")).catch((error: unknown) => {
    throw new Error(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const { name, version, license } = manifest;
  if (typeof name !== "string" || name === "") {
    throw new Error(`${dir}: package.json has no name.`);
  }
  if (typeof version !== "string" || version === "") {
    throw new Error(`${name}: package.json has no version.`);
  }
  if (typeof license !== "string" || !LICENSES.has(license)) {
    throw new Error(
      `${name}: license ${JSON.stringify(license)} is not one of ${[...LICENSES].join(", ")}.`,
    );
  }
  const files = (await readdir(dir)).sort();
  const licenseFiles = files.filter((file) => LICENSE_FILE.test(file));
  if (licenseFiles.length === 0) {
    throw new Error(`${name}: no license file (LICENSE, LICENCE, LICENSE.md, LICENSE.txt).`);
  }
  const noticeFiles = files.filter((file) => NOTICE_FILE.test(file));
  const texts: string[] = [];
  for (const file of [...licenseFiles, ...noticeFiles]) {
    texts.push(await regularText(name, join(dir, file), file));
  }
  return { name, version, license, texts };
}

// lstat: a symlink could pull any file on this machine into the published notices.
async function regularText(name: string, path: string, file: string): Promise<string> {
  if (!(await lstat(path)).isFile()) {
    throw new Error(`${name}: ${file} is not a regular file.`);
  }
  const text = (await readFile(path, "utf8")).trim();
  if (text === "") {
    throw new Error(`${name}: ${file} is empty.`);
  }
  return text;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function packageJson(): Promise<string> {
  const { version } = await readJsonObject(join(root, "package.json"));
  if (typeof version !== "string") throw new Error("package.json has no version string.");
  const { description } = await readJsonObject(join(repo, "package.json"));
  if (typeof description !== "string") throw new Error("package.json has no description.");
  const manifest = {
    name: "foxleash",
    version,
    description,
    license: "GPL-3.0-or-later",
    type: "module",
    bin: { foxleash: "foxleash.mjs" },
    engines: { node: ">=24" },
    os: ["linux"],
    repository: { type: "git", url: "git+https://github.com/mattiasw/foxleash.git" },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} is not a JSON object.`);
  }
  return { ...value };
}

if (import.meta.main) await build();
