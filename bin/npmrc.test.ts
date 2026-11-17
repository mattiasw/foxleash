import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");

const scratch = mkdtempSync(path.join(os.tmpdir(), "foxleash-npmrc-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Its own project root, so npm does not walk up to a parent folder's config.
writeFileSync(path.join(scratch, "package.json"), "{}");
const userConfig = path.join(scratch, "user-npmrc");
const globalConfig = path.join(scratch, "global-npmrc");
writeFileSync(userConfig, "");
writeFileSync(globalConfig, "");

const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith("npm_config_")),
);
env.npm_config_userconfig = userConfig;
env.npm_config_globalconfig = globalConfig;

test("npm in this repository runs no install scripts", () => {
  assert.equal(ignoreScripts(ROOT), "true");
  // Outside any project the setting is off, so the "true" above comes from the repository's
  // .npmrc and not from the environment or npm's own config.
  assert.equal(ignoreScripts(scratch), "false");

  const settings = readFileSync(path.join(ROOT, ".npmrc"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.deepEqual(settings, ["ignore-scripts=true"]);
});

function ignoreScripts(cwd: string): string {
  return execFileSync("npm", ["config", "get", "ignore-scripts"], {
    cwd,
    env,
    encoding: "utf8",
  }).trim();
}

// npm runs these around an install, pack, publish or version, never because a command names them.
const LIFECYCLE = new Set([
  "dependencies",
  "install",
  "postinstall",
  "postpack",
  "postprepare",
  "postpublish",
  "postversion",
  "preinstall",
  "prepack",
  "prepare",
  "preprepare",
  "prepublish",
  "prepublishOnly",
  "preversion",
  "publish",
  "version",
]);
// Commands that run their own pre and post scripts.
const COMMANDS = ["restart", "start", "stop", "test"];

test("the root prepare is the only script npm skips here", () => {
  const { workspaces = [] } = readPackage("package.json");
  const files = globSync(["package.json", ...workspaces.map((dir) => `${dir}/package.json`)], {
    cwd: ROOT,
  }).sort();
  const skipped = files.flatMap((file) => {
    const names = Object.keys(readPackage(file).scripts ?? {});
    return names.filter((name) => runsOnlyAsHook(name, names)).map((name) => `${file} ${name}`);
  });
  // With ignore-scripts, npm runs a script named on its command line but none of these; the
  // root prepare installs the Git hooks, and the setup runs it by name.
  assert.deepEqual(skipped, ["package.json prepare"]);
});

function readPackage(file: string): { scripts?: Record<string, string>; workspaces?: string[] } {
  return JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
}

function runsOnlyAsHook(name: string, names: string[]): boolean {
  const hooked = /^(?:pre|post)(.+)$/.exec(name)?.[1];
  return (
    LIFECYCLE.has(name) ||
    (hooked !== undefined && (names.includes(hooked) || COMMANDS.includes(hooked)))
  );
}
