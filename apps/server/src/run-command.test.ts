import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { launchDetached, runCommand } from "./run-command.ts";

const root = mkdtempSync(join(tmpdir(), "foxhand-run-"));
const LIMIT = { timeout: 10_000 };

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runCommand", () => {
  it("returns ok with code 0 for a command that succeeds", LIMIT, async () => {
    assert.deepEqual(await runCommand("/bin/sh", ["-c", "exit 0"], { timeoutMs: 5000 }), {
      status: "ok",
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("returns failed with the exit code and the captured output", LIMIT, async () => {
    const result = await runCommand("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], {
      timeoutMs: 5000,
    });
    assert.deepEqual(result, { status: "failed", code: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("returns missing for a command that does not exist", LIMIT, async () => {
    assert.deepEqual(await runCommand(join(root, "no-such-command"), [], { timeoutMs: 5000 }), {
      status: "missing",
    });
  });

  it("returns timeout when the command runs past the bound", LIMIT, async () => {
    const started = Date.now();
    assert.deepEqual(await runCommand("sleep", ["5"], { timeoutMs: 50 }), { status: "timeout" });
    assert.ok(Date.now() - started < 2000);
  });

  it("returns within the bound when a grandchild holds the output pipes", LIMIT, async () => {
    const started = Date.now();
    assert.deepEqual(await runCommand("/bin/sh", ["-c", "sleep 5; true"], { timeoutMs: 50 }), {
      status: "timeout",
    });
    assert.ok(Date.now() - started < 2000);
  });

  it("gives the child an empty stdin", LIMIT, async () => {
    const started = Date.now();
    const result = await runCommand("/bin/sh", ["-c", "cat >/dev/null; exit 0"], {
      timeoutMs: 5000,
    });
    assert.deepEqual(result, { status: "ok", code: 0, stdout: "", stderr: "" });
    assert.ok(Date.now() - started < 2000);
  });

  it("returns timeout for a child that exits cleanly on SIGTERM", LIMIT, async () => {
    const script = "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 3000)";
    assert.deepEqual(await runCommand(process.execPath, ["-e", script], { timeoutMs: 1000 }), {
      status: "timeout",
    });
  });

  it(
    "returns failed with code -1 and the error for a file that is not executable",
    LIMIT,
    async () => {
      const file = join(root, "not-executable");
      writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const result = await runCommand(file, [], { timeoutMs: 5000 });
      assert.equal(result.status, "failed");
      assert.ok(result.status === "failed");
      assert.equal(result.code, -1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /EACCES/);
    },
  );

  it("returns failed with code -1 for a child killed by an outside signal", LIMIT, async () => {
    const result = await runCommand("/bin/sh", ["-c", "kill -TERM $$"], { timeoutMs: 5000 });
    assert.deepEqual(result, {
      status: "failed",
      code: -1,
      stdout: "",
      stderr: "Command failed: /bin/sh -c kill -TERM $$\n",
    });
  });

  it("lets the process exit as soon as a fast command finishes", LIMIT, async () => {
    const url = new URL("./run-command.ts", import.meta.url).href;
    const script = `const { runCommand } = await import(${JSON.stringify(url)});
const result = await runCommand("/bin/sh", ["-c", "exit 0"], { timeoutMs: 60000 });
if (result.status !== "ok") process.exit(9);`;
    const started = Date.now();
    const result = await runCommand(process.execPath, ["--input-type=module", "-e", script], {
      timeoutMs: 10_000,
    });
    assert.deepEqual(result, { status: "ok", code: 0, stdout: "", stderr: "" });
    assert.ok(Date.now() - started < 10_000);
  });
});

describe("launchDetached", () => {
  it("resolves ok once the program started", LIMIT, async () => {
    assert.deepEqual(await launchDetached("/bin/true", []), { status: "ok" });
  });

  it("resolves missing for a program that does not exist", LIMIT, async () => {
    assert.deepEqual(await launchDetached(join(root, "no-such-command"), []), {
      status: "missing",
    });
  });

  it("resolves failed with the code for a file that is not executable", LIMIT, async () => {
    const file = join(root, "not-executable-launch");
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    assert.deepEqual(await launchDetached(file, []), { status: "failed", error: "EACCES" });
  });

  it("resolves failed when spawn throws", LIMIT, async () => {
    assert.deepEqual(await launchDetached("", []), {
      status: "failed",
      error: "ERR_INVALID_ARG_VALUE",
    });
  });

  it("neither waits for the program nor holds the process open", LIMIT, async () => {
    const url = new URL("./run-command.ts", import.meta.url).href;
    const script = `const { launchDetached } = await import(${JSON.stringify(url)});
const result = await launchDetached("sleep", ["30"]);
if (result.status !== "ok") process.exit(9);`;
    const result = await runCommand(process.execPath, ["--input-type=module", "-e", script], {
      timeoutMs: 8000,
    });
    assert.deepEqual(result, { status: "ok", code: 0, stdout: "", stderr: "" });
  });

  it("starts the program as the leader of its own session", LIMIT, async () => {
    const file = join(root, "session");
    const script =
      'read -r stat < /proc/$$/stat; set -- $stat; echo "$1 $6" > "$0.tmp"; mv "$0.tmp" "$0"';
    assert.deepEqual(await launchDetached("/bin/sh", ["-c", script, file]), { status: "ok" });
    for (let i = 0; i < 100 && !existsSync(file); i += 1) {
      await sleep(20);
    }
    const [pid, session] = readFileSync(file, "utf8").trim().split(" ");
    assert.ok(pid !== undefined && pid !== "");
    assert.equal(session, pid);
  });
});
