import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { assignShards, listE2eFiles, parseShard, readDurations, repoPath } from "./e2e-shard.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(import.meta.dirname, "e2e-shard.ts");
const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe("parseShard", () => {
  test("accepts an index from 1 to the total", () => {
    assert.deepEqual(parseShard("1/3"), { index: 1, total: 3 });
    assert.deepEqual(parseShard("3/3"), { index: 3, total: 3 });
    assert.deepEqual(parseShard("12/40"), { index: 12, total: 40 });
  });

  test("rejects anything else, naming the variable and the value", () => {
    for (const spec of ["0/3", "4/3", "3", "a/b", "1/0", " 1/3", "1/3x", "01/3", "1/03", ""]) {
      assert.throws(
        () => parseShard(spec),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("FOXLEASH_E2E_SHARD") &&
          error.message.includes(JSON.stringify(spec)),
        spec,
      );
    }
  });
});

describe("assignShards", () => {
  test("deals the longest file first, each to the lightest shard", () => {
    const durations = { "e/a": 8, "e/b": 7, "e/c": 6, "e/d": 5, "e/e": 4 };
    // 8 to shard 1, 7 to 2, 6 to 2 (7 < 8), 5 to 1 (8 < 13), 4 to 1 (13 = 13, lowest index).
    assert.deepEqual(assignShards(Object.keys(durations), durations, 2), [
      ["e/a", "e/d", "e/e"],
      ["e/b", "e/c"],
    ]);
  });

  test("deals equal weights in path order, to the lowest index on a tie", () => {
    const files = ["e/d", "e/b", "e/a", "e/c", "e/e"];
    const durations = { "e/a": 2, "e/b": 2, "e/c": 2, "e/d": 2, "e/e": 2 };
    assert.deepEqual(assignShards(files, durations, 3), [["e/a", "e/d"], ["e/b", "e/e"], ["e/c"]]);
  });

  test("weighs a file without an entry as the mean of the listed files' entries", () => {
    // The new file weighs (10 + 5 + 2) / 3, the unlisted file's 100 left out: 10, 5.67 and 5
    // each go to a shard of their own, then 2 joins 5. Weighed 1, the new file would get the 2;
    // with the 100 in the mean, it would be dealt first, to shard 1.
    const files = ["e/long", "e/new", "e/short"];
    const durations = { "e/long": 10, "e/short": 2, "e/gone": 100 };
    assert.deepEqual(assignShards([...files, "e/five"], { ...durations, "e/five": 5 }, 3), [
      ["e/long"],
      ["e/new"],
      ["e/five", "e/short"],
    ]);
  });

  test("weighs every file equally when none has an entry", () => {
    const files = ["e/a", "e/b", "e/c", "e/d"];
    assert.deepEqual(assignShards(files, { "e/other": 50 }, 2), [
      ["e/a", "e/c"],
      ["e/b", "e/d"],
    ]);
  });

  test("puts every file in exactly one shard, each shard sorted, for totals 1 to 6", () => {
    const files = Array.from({ length: 10 }, (_, i) => `e/f${i}`);
    const durations = { "e/f0": 3, "e/f2": 9, "e/f3": 1.5, "e/f5": 9, "e/f7": 0.1, "e/f8": 4 };
    for (let total = 1; total <= 6; total += 1) {
      const shards = assignShards(files, durations, total);
      assert.equal(shards.length, total);
      const all = shards.flat();
      assert.equal(all.length, files.length, `total ${total}`);
      assert.deepEqual([...all].sort(), [...files].sort(), `total ${total}`);
      for (const shard of shards) {
        assert.ok(shard.length > 0, `total ${total}`);
        assert.deepEqual(shard, [...shard].sort(), `total ${total}`);
      }
    }
  });

  test("gives the same shards whatever the order of the files", () => {
    const files = Array.from({ length: 10 }, (_, i) => `e/f${i}`);
    const durations = { "e/f0": 0.1, "e/f1": 0.2, "e/f2": 0.3, "e/f4": 7, "e/f6": 7, "e/f9": 2 };
    const expected = assignShards(files, durations, 3);
    const shuffled = [5, 2, 9, 0, 7, 4, 1, 8, 3, 6].map((i) => `e/f${i}`);
    assert.deepEqual(assignShards([...files].reverse(), durations, 3), expected);
    assert.deepEqual(assignShards(shuffled, durations, 3), expected);
  });

  test("refuses a total that is not a whole number of at least 1", () => {
    for (const total of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => assignShards(["e/a"], {}, total), RangeError, String(total));
    }
  });
});

describe("readDurations", () => {
  test("reads the durations file under the root", () => {
    const paths: string[] = [];
    const read = (path: string): string => {
      paths.push(path);
      return '{ "e2e/a.test.ts": 12.5, "e2e/b.test.ts": 0.1 }';
    };
    assert.deepEqual(readDurations("/repo", { read }), {
      "e2e/a.test.ts": 12.5,
      "e2e/b.test.ts": 0.1,
    });
    assert.deepEqual(paths, [join("/repo", "bin/e2e-durations.json")]);
  });

  test("keeps a __proto__ key as an own entry", () => {
    const durations = readDurations("/repo", { read: () => '{ "__proto__": 3 }' });
    assert.ok(Object.hasOwn(durations, "__proto__"));
    assert.equal(Object.getPrototypeOf(durations), Object.prototype);
  });

  test("refuses anything but an object of positive finite seconds, naming the file", () => {
    for (const text of [
      "[]",
      "null",
      "3",
      '"x"',
      '{ "e2e/a.test.ts": "3" }',
      '{ "e2e/a.test.ts": 0 }',
      '{ "e2e/a.test.ts": -2 }',
      '{ "e2e/a.test.ts": 1e999 }',
      '{ "e2e/a.test.ts": null }',
      "{",
    ]) {
      assert.throws(
        () => readDurations("/repo", { read: () => text }),
        (error: unknown) =>
          error instanceof Error && error.message.startsWith("bin/e2e-durations.json: "),
        text,
      );
    }
  });

  test("names the file when it cannot be read", () => {
    const cause = new Error("ENOENT: no such file");
    assert.throws(
      () =>
        readDurations("/repo", {
          read: () => {
            throw cause;
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "bin/e2e-durations.json: cannot read the e2e durations: ENOENT: no such file" &&
        error.cause === cause,
    );
  });
});

describe("repoPath", () => {
  test("gives the path relative to the root with / separators", () => {
    assert.equal(repoPath("/repo", join("/repo", "e2e", "a.test.ts")), "e2e/a.test.ts");
  });
});

describe("the repository's e2e files and durations", () => {
  test("lists sorted e2e test files whose names the npm script can word-split", () => {
    const files = listE2eFiles(ROOT);
    assert.ok(files.length > 0);
    assert.deepEqual(files, [...files].sort());
    for (const file of files) assert.match(file, /^e2e\/[\w./-]+\.test\.ts$/);
  });

  test("has a positive duration only for files that exist", () => {
    const files = new Set(listE2eFiles(ROOT));
    for (const [file, seconds] of Object.entries(readDurations(ROOT))) {
      assert.ok(files.has(file), `${file} is not an e2e test file`);
      assert.ok(Number.isFinite(seconds) && seconds > 0, file);
    }
  });

  test("deals every file to exactly one of three non-empty shards", () => {
    const files = listE2eFiles(ROOT);
    const shards = assignShards(files, readDurations(ROOT), 3);
    assert.deepEqual(shards.flat().sort(), files);
    for (const shard of shards) assert.ok(shard.length > 0);
  });
});

describe("the CLI", () => {
  test("prints every file when FOXLEASH_E2E_SHARD is unset or empty", () => {
    const expected = `${listE2eFiles(ROOT).join("\n")}\n`;
    for (const shard of [undefined, ""]) {
      const result = runCli(SCRIPT, shard);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
      assert.equal(result.stderr, "");
    }
  });

  test("prints the files of the shard FOXLEASH_E2E_SHARD selects", () => {
    const files = listE2eFiles(ROOT);
    const result = runCli(SCRIPT, "2/3");
    assert.equal(result.status, 0, result.stderr);
    const shard = assignShards(files, readDurations(ROOT), 3)[1] ?? [];
    assert.equal(result.stdout, `${shard.join("\n")}\n`);
  });

  test("fails with nothing on stdout for an invalid shard or more shards than files", () => {
    for (const shard of ["4/3", "x", "100/100"]) {
      const result = runCli(SCRIPT, shard);
      assert.equal(result.status, 1, shard);
      assert.equal(result.stdout, "", shard);
      assert.match(result.stderr, /^\[e2e-shard\] FOXLEASH_E2E_SHARD .+\n$/, shard);
    }
  });

  test("fails when there is no e2e test file", () => {
    const { script } = copyScript();
    for (const shard of [undefined, "1/1"]) {
      const result = runCli(script, shard);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^\[e2e-shard\] no e2e test files under .+\n$/);
    }
  });

  test("reads the durations only for a shard, and fails naming a missing file", () => {
    const { root, script } = copyScript();
    mkdirSync(join(root, "e2e", "sub"), { recursive: true });
    writeFileSync(join(root, "e2e", "b.test.ts"), "");
    writeFileSync(join(root, "e2e", "sub", "a.test.ts"), "");
    writeFileSync(join(root, "e2e", "helper.ts"), "");
    const all = runCli(script, undefined);
    assert.equal(all.status, 0, all.stderr);
    assert.equal(all.stdout, "e2e/b.test.ts\ne2e/sub/a.test.ts\n");
    const missing = runCli(script, "1/2");
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /^\[e2e-shard\] bin\/e2e-durations\.json: cannot read .+\n$/);
    writeFileSync(join(root, "bin", "e2e-durations.json"), '{ "e2e/b.test.ts": 9 }\n');
    const sharded = runCli(script, "2/2");
    assert.equal(sharded.status, 0, sharded.stderr);
    assert.equal(sharded.stdout, "e2e/sub/a.test.ts\n");
  });
});

function runCli(
  script: string,
  shard: string | undefined,
): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.FOXLEASH_E2E_SHARD;
  if (shard !== undefined) env.FOXLEASH_E2E_SHARD = shard;
  return spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 30_000 });
}

// A copy of the script in a temporary root, which it takes as the repository.
function copyScript(): { root: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), "e2e-shard-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "bin"));
  const script = join(root, "bin", "e2e-shard.ts");
  copyFileSync(SCRIPT, script);
  return { root, script };
}
