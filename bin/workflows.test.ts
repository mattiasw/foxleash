import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

// The workflows are read as text, without a YAML parser: every lookup asserts that it found what
// it reads, so a reshaped file fails here instead of passing vacuously.

const ROOT = path.join(import.meta.dirname, "..");
const WORKFLOWS = ".github/workflows";
const CI_FILE = `${WORKFLOWS}/ci.yml`;

// owner/repo[/path]@<40-hex commit> # v<version>. The owner is a GitHub account name and no
// segment is only dots, so neither a local action (./...), which the runner takes as a path
// whatever follows, nor a path the runner joins its way out of the action's directory can pass.
const PINNED =
  /^\s*(?:-\s+)?uses:\s+[A-Za-z0-9][A-Za-z0-9-]*(?:\/(?!\.+[/@])[A-Za-z0-9_.-]+)+@[0-9a-f]{40} # v\d+(?:\.\d+)*\s*$/;
const SCOPE = /^[a-z][a-z-]*: (?:read|write|none)$/;
// YAML's whitespace is space and tab; trim() also strips Unicode spaces, which YAML reads as
// content, so a # after one starts no comment.
const COMMENT = /^[ \t]*#/;

// Listed rather than globbed: a glob skips dot-named files and matches the extension's case.
const FILES = readdirSync(path.join(ROOT, WORKFLOWS))
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort()
  .map((name) => `${WORKFLOWS}/${name}`);

describe("the workflows run with a token they declare and actions pinned by commit", () => {
  test("the workflow files include ci.yml", () => {
    assert.ok(
      FILES.includes(CI_FILE),
      `no ci.yml found in ${WORKFLOWS} (found ${JSON.stringify(FILES)}), so the other checks may be running on nothing`,
    );
  });

  test("every workflow breaks lines only where these checks split them", () => {
    const offenders = FILES.filter((file) => hasOtherLineBreak(read(file)));
    assert.deepEqual(
      offenders,
      [],
      "break lines with \\n or \\r\\n only: YAML also breaks at a lone \\r, U+0085, U+2028 or U+2029, which these checks read as part of one line, so a line after a comment there would go unchecked",
    );
  });

  test("every workflow declares its own token permissions", () => {
    const offenders = FILES.filter((file) => !ownsPermissions(read(file)));
    assert.deepEqual(
      offenders,
      [],
      "each workflow needs exactly one top-level permissions: key, either permissions: {} or a block listing its scopes, so it does not run with the repository's default token",
    );
  });

  test("ci.yml's default token may only read contents", () => {
    const scopes = topLevelPermissions(read(CI_FILE));
    assert.ok(scopes !== undefined, `${CI_FILE} has no top-level permissions: block`);
    assert.deepEqual(
      scopes,
      ["contents: read"],
      `${CI_FILE}'s top-level permissions must be exactly contents: read; a job that needs more says so in its own block`,
    );
  });

  test("every action is named by a commit, with its release tag in a comment", () => {
    const offenders = FILES.flatMap((file) =>
      unpinnedUses(read(file)).map((line) => `${file}:${line}`),
    );
    assert.deepEqual(
      offenders,
      [],
      "name each action by the commit its release tag points to, with the tag in a comment: uses: owner/repo@<40-hex commit> # v1.2.3",
    );
  });

  test("ci.yml uses actions, so the pin check reads something", () => {
    assert.ok(
      usesLines(read(CI_FILE)).length > 0,
      `${CI_FILE} has no uses: line this test can see`,
    );
  });
});

describe("the workflow readers", () => {
  test("unpinnedUses reports every uses that is not a remote action pinned by commit", () => {
    const source = [
      "steps:",
      "  - uses: actions/checkout@v7",
      "  - uses: ./local",
      "  - uses: ./.github/actions/x@3d3c42e5aac5ba805825da76410c181273ba90b1 # v1",
      '  - "uses": actions/checkout@v7',
      "  - ? uses",
      "    : actions/checkout@v7",
      "  - {uses",
      "    : actions/checkout@v7}",
      "  - name: &key uses",
      "  - *key : actions/checkout@v7",
      "  - uses: actions/checkout/../../../../x@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "  - {name:",
      "     \u00a0#hidden, uses: evil/x@main}",
      "permissions:",
      "  statuses: read",
      "  # - uses: actions/checkout@v7",
      "  - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0",
      "    uses: octo-org/repo/.github/workflows/x.yml@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v1",
    ].join("\n");
    assert.deepEqual(unpinnedUses(source), [
      "2: - uses: actions/checkout@v7",
      "3: - uses: ./local",
      "4: - uses: ./.github/actions/x@3d3c42e5aac5ba805825da76410c181273ba90b1 # v1",
      '5: - "uses": actions/checkout@v7',
      "6: - ? uses",
      "8: - {uses",
      "10: - name: &key uses",
      "12: - uses: actions/checkout/../../../../x@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "14: #hidden, uses: evil/x@main}",
    ]);
  });

  test("topLevelPermissions ignores a job-level block", () => {
    const source = "jobs:\n  x:\n    permissions:\n      contents: read\n";
    assert.equal(topLevelPermissions(source), undefined);
  });

  test("topLevelPermissions reads past comments and blank lines up to the next top-level key", () => {
    const source =
      "permissions:\n  # note\n  contents: write\n\njobs:\n  x:\n    permissions:\n      actions: read\n";
    assert.deepEqual(topLevelPermissions(source), ["contents: write"]);
  });

  test("ownsPermissions accepts only an empty map or a block of scopes, declared once", () => {
    assert.equal(ownsPermissions("permissions: {}\njobs:\n"), true);
    assert.equal(ownsPermissions("permissions:\n  contents: read\njobs:\n"), true);
    assert.equal(ownsPermissions("jobs:\n  x:\n    permissions: {}\n"), false);
    assert.equal(ownsPermissions("permissions: write-all\njobs:\n"), false);
    assert.equal(ownsPermissions('permissions: "write-all"\njobs:\n'), false);
    assert.equal(ownsPermissions("permissions:\n  write-all\njobs:\n"), false);
    assert.equal(ownsPermissions("permissions:\njobs:\n"), false);
    assert.equal(ownsPermissions('permissions: {}\n"permissions": write-all\n'), false);
    assert.equal(ownsPermissions("permissions: {}\n? permissions\n: write-all\n"), false);
    assert.equal(ownsPermissions("permissions:\n  \u00a0#x: write\n  contents: read\n"), false);
  });

  test("hasOtherLineBreak finds every line break but \\n and \\r\\n", () => {
    assert.equal(hasOtherLineBreak("permissions:\r\n  contents: read\r\n"), false);
    for (const lineBreak of ["\r", "\u0085", "\u2028", "\u2029"]) {
      assert.equal(
        hasOtherLineBreak(`permissions:\n  # note${lineBreak}  id-token: write\n`),
        true,
        JSON.stringify(lineBreak),
      );
    }
  });
});

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

function hasOtherLineBreak(source: string): boolean {
  return /\r(?!\n)|[\u0085\u2028\u2029]/.test(source);
}

// An allow-list of the two forms in use: YAML spells write-all in many ways (quoted, anchored,
// tagged, as a scalar on the next line), and a second key could say something else.
function ownsPermissions(source: string): boolean {
  const keys = source
    .split("\n")
    .filter((line) => /^(?:\?\s+)?["']?permissions["']?\s*(?::|$)/.test(line));
  if (keys.length !== 1) return false;
  if (/^permissions:\s*\{\}\s*$/.test(keys[0] ?? "")) return true;
  const scopes = topLevelPermissions(source);
  return scopes !== undefined && scopes.length > 0 && scopes.every((scope) => SCOPE.test(scope));
}

// The lines of the top-level permissions block, trimmed, without blank and comment lines.
function topLevelPermissions(source: string): string[] | undefined {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^permissions:\s*$/.test(line));
  if (start < 0) return undefined;
  const scopes: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || COMMENT.test(line)) continue;
    if (!/^\s/.test(line)) break;
    scopes.push(line.trim());
  }
  return scopes;
}

function unpinnedUses(source: string): string[] {
  return usesLines(source)
    .filter(([, line]) => !PINNED.test(line))
    .map(([number, line]) => `${number}: ${line.trim()}`);
}

// Inclusive on purpose: every line that names uses outside a comment, and every explicit key (? on
// its own line, the value on the next), is reported and must then match PINNED, so a key split
// over two lines of a flow mapping, or repeated through an alias, is caught where it is written.
// \b keeps statuses: out.
function usesLines(source: string): Array<[number, string]> {
  return source
    .split("\n")
    .map((line, index): [number, string] => [index + 1, line])
    .filter(
      ([, line]) =>
        !COMMENT.test(line) && (/\buses\b/i.test(line) || /^\s*(?:-\s+)?\?(?:\s|$)/.test(line)),
    );
}
