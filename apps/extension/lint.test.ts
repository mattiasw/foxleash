import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { esbuildOptions } from "./build.ts";
import { lintEnv, lintFailures, outputFailures } from "./lint.ts";

const androidMinVersionWarning = {
  _type: "warning",
  code: "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION",
  message: "Manifest key not supported by the specified minimum Firefox for Android version",
  description:
    '"strict_min_version" requires Firefox for Android 140, which was released before version 142 introduced support for "browser_specific_settings.gecko.data_collection_permissions".',
  file: "manifest.json",
};

const permissionsWarning = {
  _type: "warning",
  code: "MANIFEST_PERMISSIONS",
  message: '/permissions: Invalid permissions "fooPermission" at 7.',
  description: "Warning: Your manifest contains permissions that are not supported.",
  file: "manifest.json",
};

function report(fields: { errors?: unknown[]; warnings?: unknown[]; notices?: unknown[] }) {
  return { errors: [], warnings: [], notices: [], ...fields };
}

describe("lintFailures", () => {
  test("passes a clean report", () => {
    assert.deepEqual(lintFailures(report({})), []);
  });

  test("fails the Firefox for Android minimum-version warning", () => {
    assert.deepEqual(lintFailures(report({ warnings: [androidMinVersionWarning] })), [
      `warning KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION in manifest.json: ${androidMinVersionWarning.message} ${androidMinVersionWarning.description}`,
    ]);
  });

  test("fails each of two warnings", () => {
    assert.deepEqual(
      lintFailures(report({ warnings: [androidMinVersionWarning, permissionsWarning] })),
      [
        `warning KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION in manifest.json: ${androidMinVersionWarning.message} ${androidMinVersionWarning.description}`,
        `warning MANIFEST_PERMISSIONS in manifest.json: ${permissionsWarning.message} ${permissionsWarning.description}`,
      ],
    );
  });

  test("fails another warning and names its code, file, position and message", () => {
    const warning = { ...permissionsWarning, line: 3, column: 7 };
    assert.deepEqual(lintFailures(report({ warnings: [warning] })), [
      `warning MANIFEST_PERMISSIONS in manifest.json:3:7: ${permissionsWarning.message} ${permissionsWarning.description}`,
    ]);
  });

  test("fails another error", () => {
    const error = {
      _type: "error",
      code: "MANIFEST_BACKGROUND_FILE_NOT_FOUND",
      message: "A background script defined in the manifest could not be found.",
      file: "manifest.json",
    };
    assert.deepEqual(lintFailures(report({ errors: [error] })), [
      `error MANIFEST_BACKGROUND_FILE_NOT_FOUND in manifest.json: ${error.message}`,
    ]);
  });

  test("passes notices", () => {
    const notice = {
      _type: "notice",
      code: "PERMISSION_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION",
      message: "Permission not supported by the specified minimum Firefox for Android version",
      file: "manifest.json",
    };
    assert.deepEqual(lintFailures(report({ notices: [notice] })), []);
  });

  test("fails a report that is not an object", () => {
    for (const value of [null, [], "report", 1]) {
      const failures = lintFailures(value);
      assert.equal(failures.length, 1, JSON.stringify(value));
      assert.match(failures[0] ?? "", /not in the expected shape: the report is not an object/);
    }
  });

  test("fails a report whose warnings are not an array", () => {
    const failures = lintFailures({ errors: [], warnings: {}, notices: [] });
    assert.deepEqual(failures.length, 1);
    assert.match(failures[0] ?? "", /warnings is not an array/);
  });

  test("fails a report without errors", () => {
    const failures = lintFailures({ warnings: [], notices: [] });
    assert.deepEqual(failures.length, 1);
    assert.match(failures[0] ?? "", /errors is not an array/);
  });

  test("fails an entry that is not an object", () => {
    assert.deepEqual(lintFailures(report({ warnings: ["oops"] })), ['warning: "oops"']);
    assert.deepEqual(lintFailures(report({ errors: [null] })), ["error: null"]);
  });

  test("prints placeholders for missing fields", () => {
    assert.deepEqual(lintFailures(report({ warnings: [{ line: "3" }] })), ["warning ? in ?: ?"]);
  });
});

describe("outputFailures", () => {
  const clean = JSON.stringify(report({}));

  test("passes a clean report with status 0", () => {
    assert.deepEqual(outputFailures({ status: 0, signal: null, stdout: clean, stderr: "" }), []);
  });

  test("passes a clean report with status 0 when web-ext also writes to stderr", () => {
    assert.deepEqual(
      outputFailures({ status: 0, signal: null, stdout: clean, stderr: "note\n" }),
      [],
    );
  });

  test("fails output that is not JSON and shows stderr", () => {
    const failures = outputFailures({ status: 1, signal: null, stdout: "", stderr: "boom\n" });
    assert.equal(failures.length, 2);
    assert.match(failures[0] ?? "", /did not print a JSON report/);
    assert.equal(failures[1], "web-ext stderr:\nboom");
  });

  test("fails a clean report with a non-zero status", () => {
    assert.deepEqual(outputFailures({ status: 1, signal: null, stdout: clean, stderr: " \n" }), [
      "web-ext lint exited with status 1",
    ]);
  });

  test("fails a clean report from a killed web-ext", () => {
    assert.deepEqual(
      outputFailures({ status: null, signal: "SIGTERM", stdout: clean, stderr: "" }),
      ["web-ext lint exited with status SIGTERM"],
    );
  });

  test("fails when web-ext cannot be started", () => {
    const result = spawnSync("foxleash-no-such-command", [], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const failures = outputFailures(result);
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /^could not run web-ext lint: .*ENOENT/);
  });

  test("reports an error finding once, without a status line", () => {
    const stdout = JSON.stringify(report({ errors: [{ code: "E", message: "m", file: "f" }] }));
    assert.deepEqual(outputFailures({ status: 1, signal: null, stdout, stderr: "" }), [
      "error E in f: m",
    ]);
  });
});

describe("lintEnv", () => {
  test("drops every variable that starts with WEB_EXT and keeps the rest", () => {
    const env = {
      PATH: "/usr/bin",
      MY_WEB_EXT: "kept",
      WEB_EXT_WARNINGS_AS_ERRORS: "true",
      WEB_EXT_SELF_HOSTED: "true",
      WEB_EXTIGNORE_FILES: "extra.js",
      WEB_EXTCONFIG: "config.js",
    };
    const copy = { ...env };
    assert.deepEqual(lintEnv(env), { PATH: "/usr/bin", MY_WEB_EXT: "kept" });
    assert.deepEqual(env, copy);
  });
});

describe("lint.ts as a program", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "foxleash-lint-"));
    const script = [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" > "$FAKE_ARGS"',
      'env | grep "^WEB_EXT" > "$FAKE_ENV"',
      'cat "$FAKE_REPORT"',
      'exit "$FAKE_STATUS"',
      "",
    ].join("\n");
    await writeFile(join(dir, "web-ext"), script);
    await chmod(join(dir, "web-ext"), 0o755);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runLint(lintReport: unknown) {
    await writeFile(join(dir, "report.json"), JSON.stringify(lintReport));
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const result = spawnSync(process.execPath, [join(import.meta.dirname, "lint.ts")], {
      encoding: "utf8",
      env: {
        ...env,
        PATH: [dir, process.env.PATH].join(delimiter),
        WEB_EXT_WARNINGS_AS_ERRORS: "true",
        WEB_EXTIGNORE_FILES: "extra.js",
        FAKE_ARGS: join(dir, "args.txt"),
        FAKE_ENV: join(dir, "env.txt"),
        FAKE_REPORT: join(dir, "report.json"),
        FAKE_STATUS: "0",
      },
    });
    return {
      ...result,
      args: await readFile(join(dir, "args.txt"), "utf8"),
      webExtEnv: await readFile(join(dir, "env.txt"), "utf8"),
    };
  }

  test("passes silently on a large clean report", async () => {
    const large = {
      ...report({}),
      metadata: { padding: "x".repeat(2 * 1024 * 1024) },
    };
    const result = await runLint(large);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "");
    assert.equal(result.status, 0);
    assert.equal(
      result.args,
      [
        "lint",
        "--source-dir",
        join(import.meta.dirname, "dist"),
        "--output",
        "json",
        "--no-config-discovery",
        "",
      ].join("\n"),
    );
    assert.equal(result.webExtEnv, "");
  });

  test("fails on warnings and prints each one", async () => {
    const result = await runLint(
      report({ warnings: [androidMinVersionWarning, permissionsWarning] }),
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^warning KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION in manifest\.json: /m,
    );
    assert.match(result.stderr, /^warning MANIFEST_PERMISSIONS in manifest\.json: /m);
  });
});

describe("manifest.json", () => {
  // AMO would mark every version that has gecko_android compatible with Firefox for Android.
  test("has no Firefox for Android key", async () => {
    const settings = await browserSpecificSettings();
    assert.ok("gecko" in settings);
    assert.equal(Object.hasOwn(settings, "gecko_android"), false);
  });

  // The current ESR; on 142 to 151 tabs.captureTab is not a function. Without gecko_android the
  // linter checks Firefox for Android, which has data_collection_permissions from 142, against it.
  test("requires Firefox 153 or later", async () => {
    const gecko = await geckoSettings();
    assert.ok("strict_min_version" in gecko);
    assert.equal(gecko.strict_min_version, "153.0");
  });

  test("builds for the minimum Firefox version", async () => {
    const gecko = await geckoSettings();
    assert.ok("strict_min_version" in gecko);
    assert.ok(typeof gecko.strict_min_version === "string");
    const major = gecko.strict_min_version.split(".")[0];
    assert.equal(esbuildOptions.target, `firefox${major}`);
  });

  // Firefox's Manifest V3 default for extension pages adds upgrade-insecure-requests, which turns
  // download's fetch of an http address outside loopback into an https request to another site.
  test("declares the extension pages' policy without upgrading http requests", async () => {
    const manifest = await readManifest();
    assert.ok("content_security_policy" in manifest);
    assert.deepEqual(manifest.content_security_policy, { extension_pages: "script-src 'self'" });
  });
});

async function geckoSettings(): Promise<object> {
  const settings = await browserSpecificSettings();
  assert.ok("gecko" in settings);
  const gecko = settings.gecko;
  assert.ok(typeof gecko === "object" && gecko !== null);
  return gecko;
}

async function browserSpecificSettings(): Promise<object> {
  const manifest = await readManifest();
  assert.ok("browser_specific_settings" in manifest);
  const settings = manifest.browser_specific_settings;
  assert.ok(typeof settings === "object" && settings !== null);
  return settings;
}

async function readManifest(): Promise<object> {
  const manifest: unknown = JSON.parse(
    await readFile(join(import.meta.dirname, "manifest.json"), "utf8"),
  );
  assert.ok(typeof manifest === "object" && manifest !== null);
  return manifest;
}
