import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { lintEnv, lintFailures, outputFailures } from "./lint.ts";

const allowedWarning = {
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

  test("passes the known Firefox for Android warning", () => {
    assert.deepEqual(lintFailures(report({ warnings: [allowedWarning] })), []);
  });

  test("passes several copies of the known warning", () => {
    assert.deepEqual(lintFailures(report({ warnings: [allowedWarning, allowedWarning] })), []);
  });

  test("fails the known code when the description names another key", () => {
    const warning = {
      ...allowedWarning,
      description: allowedWarning.description.replace(
        "browser_specific_settings.gecko.data_collection_permissions",
        "options_ui.open_in_tab",
      ),
    };
    const failures = lintFailures(report({ warnings: [warning] }));
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /options_ui\.open_in_tab/);
  });

  test("fails the known code when the description names a sub-key", () => {
    const warning = {
      ...allowedWarning,
      description: allowedWarning.description.replace(
        "data_collection_permissions",
        "data_collection_permissions.optional",
      ),
    };
    assert.equal(lintFailures(report({ warnings: [warning] })).length, 1);
  });

  test("fails the known code and description in another file", () => {
    const warning = { ...allowedWarning, file: "background.js" };
    const failures = lintFailures(report({ warnings: [warning] }));
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /background\.js/);
  });

  test("fails the known warning with text appended to its description", () => {
    const warning = {
      ...allowedWarning,
      description: `${allowedWarning.description} Also "permissions".`,
    };
    assert.equal(lintFailures(report({ warnings: [warning] })).length, 1);
  });

  test("fails the known warning with text before its description", () => {
    const warning = { ...allowedWarning, description: `Also ${allowedWarning.description}` };
    assert.equal(lintFailures(report({ warnings: [warning] })).length, 1);
  });

  test("fails another warning and names its code, file, position and message", () => {
    const warning = { ...permissionsWarning, line: 3, column: 7 };
    assert.deepEqual(lintFailures(report({ warnings: [warning] })), [
      `warning MANIFEST_PERMISSIONS in manifest.json:3:7: ${permissionsWarning.message} ${permissionsWarning.description}`,
    ]);
  });

  test("fails an error that carries the known warning's code, file and description", () => {
    const error = { ...allowedWarning, _type: "error" };
    const failures = lintFailures(report({ errors: [error] }));
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /^error KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION /);
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

  test("fails only the other warning next to the known one", () => {
    const failures = lintFailures(report({ warnings: [allowedWarning, permissionsWarning] }));
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /MANIFEST_PERMISSIONS/);
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

  test("fails the known warning when its description is not a string", () => {
    const warning = { ...allowedWarning, description: [allowedWarning.description] };
    assert.equal(lintFailures(report({ warnings: [warning] })).length, 1);
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
    const result = spawnSync("foxhand-no-such-command", [], {
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
    dir = await mkdtemp(join(tmpdir(), "foxhand-lint-"));
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

  test("passes silently on a large report with only the known warning", async () => {
    const large = {
      ...report({ warnings: [allowedWarning] }),
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

  test("fails on another warning and prints it", async () => {
    const result = await runLint(report({ warnings: [allowedWarning, permissionsWarning] }));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^warning MANIFEST_PERMISSIONS in manifest\.json: /);
  });
});

describe("manifest.json", () => {
  test("has no Firefox for Android key", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(join(import.meta.dirname, "manifest.json"), "utf8"),
    );
    assert.ok(typeof manifest === "object" && manifest !== null);
    assert.ok("browser_specific_settings" in manifest);
    const settings = manifest.browser_specific_settings;
    assert.ok(typeof settings === "object" && settings !== null);
    assert.ok("gecko" in settings);
    assert.equal(Object.hasOwn(settings, "gecko_android"), false);
  });
});
