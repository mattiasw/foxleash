import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { Writable } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADDON_PAGE_URL,
  EXTENSION_ID,
  PROTOCOL_VERSION,
  protocolMismatch,
  SETUP_COMMAND,
  versionDifference,
} from "@foxleash/protocol";
import { type DoctorOptions, doctor, type Spawn } from "./doctor.ts";
import { createFrameReader, encodeFrame, FRAME_LIMIT } from "./framing.ts";
import { type ExtensionSource, install, installPaths } from "./install.ts";
import type { Launch, Run, RunResult } from "./run-command.ts";
import { type FakeHost, startFakeHost } from "./testing/fake-host.ts";
import { SERVER_VERSION } from "./version.ts";

interface Fixture {
  home: string;
  main: string;
  manifest: string;
  launcher: string;
  socketDir: string;
}

interface Result {
  code: number;
  lines: string[];
}

interface RunCall {
  command: string;
  args: readonly string[];
  options: { timeoutMs: number };
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: Parameters<Spawn>[2];
  child: ReturnType<Spawn> | undefined;
}

interface SpawnRecorder {
  spawn: Spawn;
  calls: SpawnCall[];
}

const uid = currentUid();
const root = mkdtempSync("/tmp/foxleash-test-");
const VERSION = "1.2.3";
const HOST_VERSION = "2.0.0";
// The host's, so that only the tests about a version difference see its warning.
const EXTENSION_VERSION = HOST_VERSION;
const SH = "/bin/sh";
const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const LIMIT = { timeout: 10_000 };
const REAL_LIMIT = { timeout: 20_000 };
const SHORT = { welcomeMs: 300, exitMs: 300, killMs: 300 };
const SETUP = "run npm run setup";
const FLATPAK_FIREFOX = ".var/app/org.mozilla.firefox";
const DEAD_PID = 2147483647;
const PERMISSION_OK = "ok extension permissions: access to all websites granted";
const hosts: FakeHost[] = [];
const servers: net.Server[] = [];
let counter = 0;

after(async () => {
  setTimeout(() => process.exit(1), 5000).unref();
  await Promise.all(hosts.map((host) => host.close()));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  rmSync(root, { recursive: true, force: true });
});

describe("doctor, everything in order", () => {
  it("passes with the real host behind the launcher", REAL_LIMIT, async () => {
    const f = await fixture();
    await install({
      home: f.home,
      node: process.execPath,
      program: { kind: "source", main: MAIN },
      ...quiet(),
    });
    const host = await fakeHost(f.socketDir, process.pid);
    const closed = once(host.events, "close");
    const claude = fakeRun(claudeOk(process.execPath, MAIN));
    const result = await runDoctor(f, { node: process.execPath, main: MAIN, run: claude.run });
    assert.deepEqual(result.lines, [
      `ok native manifest: ${f.manifest}`,
      `ok launcher: ${f.launcher} runs host version ${SERVER_VERSION}, protocol ${PROTOCOL_VERSION}`,
      "ok claude code: foxleash is registered",
      `  Command: ${process.execPath}`,
      `  Args: ${MAIN} mcp`,
      `ok socket directory: ${f.socketDir}`,
      hostOk(host, process.pid),
      extensionOk(),
      PERMISSION_OK,
      "7 checks, 0 failed",
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(host.hellos, [
      { type: "hello", role: "mcp", protocol: PROTOCOL_VERSION, version: VERSION },
    ]);
    await closed;
    assert.equal(host.closes, 1);
  });

  it("passes with a fast launcher and sends it one extension hello", LIMIT, async () => {
    const f = await fixture();
    const host = await fakeHost(f.socketDir, process.pid);
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(result.lines, [...allOk(f, host), "7 checks, 0 failed"]);
    assert.equal(result.code, 0);
    assert.deepEqual(
      readFileSync(path.join(f.home, "stdin.bin")),
      encodeFrame(
        JSON.stringify({
          type: "hello",
          role: "extension",
          protocol: PROTOCOL_VERSION,
          version: VERSION,
        }),
      ),
    );
    const [call] = recorder.calls;
    assert.ok(call !== undefined && recorder.calls.length === 1);
    assert.equal(call.command, f.launcher);
    assert.deepEqual(call.args, []);
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "ignore"]);
    assert.equal(call.child?.exitCode, 0);
  });
});

describe("doctor, the native manifest", () => {
  it("fails without a manifest and skips the launcher", LIMIT, async () => {
    const f = await fixture();
    const host = await fakeHost(f.socketDir, process.pid);
    unlinkSync(f.manifest);
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(result.lines, [
      `FAIL native manifest: ${f.manifest} does not exist; ${SETUP}`,
      ...claudeLines(f),
      `ok socket directory: ${f.socketDir}`,
      hostOk(host, process.pid),
      extensionOk(),
      PERMISSION_OK,
      "6 checks, 1 failed",
    ]);
    assert.equal(result.code, 1);
    assert.equal(recorder.calls.length, 0);
  });

  it(
    "fails a manifest that allows another extension and still runs the launcher",
    LIMIT,
    async () => {
      const f = await fixture();
      rewriteManifest(f, { allowed_extensions: ["other@example.com"] });
      const result = await runDoctor(f);
      assert.deepEqual(section(result, ["native manifest", "launcher"]), [
        `FAIL native manifest: ${f.manifest} does not allow the extension ${EXTENSION_ID}; ${SETUP}`,
        launcherOk(f),
      ]);
      assert.equal(result.code, 1);
    },
  );

  it("fails an allowed_extensions that is not a list", LIMIT, async () => {
    const f = await fixture();
    rewriteManifest(f, { allowed_extensions: EXTENSION_ID });
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["native manifest", "launcher"]), [
      `FAIL native manifest: ${f.manifest} does not allow the extension ${EXTENSION_ID}; ${SETUP}`,
      launcherOk(f),
    ]);
  });

  it("reports each bad field and skips a relative launcher path", LIMIT, async () => {
    const f = await fixture();
    rewriteManifest(f, { name: "other", type: "pipe", path: "relative/foxleash-host" });
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(section(result, ["native manifest", "launcher"]), [
      `FAIL native manifest: ${f.manifest} has a name other than "foxleash"; ${SETUP}`,
      `FAIL native manifest: ${f.manifest} has a type other than "stdio"; ${SETUP}`,
      `FAIL native manifest: ${f.manifest} has no absolute path to the launcher; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
    assert.equal(recorder.calls.length, 0);
  });

  it("reports every field of an empty object", LIMIT, async () => {
    const f = await fixture();
    writeFileSync(f.manifest, "{}");
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["native manifest", "launcher"]), [
      `FAIL native manifest: ${f.manifest} has a name other than "foxleash"; ${SETUP}`,
      `FAIL native manifest: ${f.manifest} has a type other than "stdio"; ${SETUP}`,
      `FAIL native manifest: ${f.manifest} does not allow the extension ${EXTENSION_ID}; ${SETUP}`,
      `FAIL native manifest: ${f.manifest} has no absolute path to the launcher; ${SETUP}`,
    ]);
  });

  for (const text of ["{", "[]", "null", "3", ""]) {
    it(`fails a manifest of ${JSON.stringify(text)} as not a JSON object`, LIMIT, async () => {
      const f = await fixture();
      writeFileSync(f.manifest, text);
      const recorder = recordingSpawn();
      const result = await runDoctor(f, { spawn: recorder.spawn });
      assert.deepEqual(section(result, ["native manifest", "launcher"]), [
        `FAIL native manifest: ${f.manifest} is not a JSON object; ${SETUP}`,
      ]);
      assert.equal(result.code, 1);
      assert.equal(recorder.calls.length, 0);
    });
  }

  it("fails a directory at the manifest path", LIMIT, async () => {
    const f = await fixture();
    unlinkSync(f.manifest);
    mkdirSync(f.manifest);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["native manifest", "launcher"]), [
      `FAIL native manifest: ${f.manifest} is not a regular file; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
  });

  it("fails a manifest it cannot read", LIMIT, async () => {
    const f = await fixture();
    chmodSync(f.manifest, 0);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["native manifest", "launcher"]), [
      `FAIL native manifest: ${f.manifest} cannot be read: EACCES; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
  });
});

describe("doctor, running the launcher", () => {
  it("runs it with only HOME, PATH and a private runtime directory", LIMIT, async () => {
    const f = await fixture("exit 3\n");
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} exited with code 3 before answering; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
    const xdg = runtimeDir(recorder);
    assert.deepEqual(recorder.calls[0]?.options.env, {
      HOME: f.home,
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: xdg,
    });
    assert.ok(xdg.startsWith("/tmp/foxleash-doctor-"), xdg);
    assert.equal(existsSync(xdg), false);
  });

  it("names the cause when the launcher's program is not there", LIMIT, async () => {
    const f = await fixture();
    const node = path.join(f.home, "removed-node");
    await install({ home: f.home, node, program: { kind: "source", main: f.main }, ...quiet() });
    const result = await runDoctor(f, { node, run: fakeRun(claudeOk(node, f.main)).run });
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} exited with code 127 before answering, so the shell did not find what it runs: '${node}' '${f.main}' host; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
  });

  it("survives a launcher that exits without reading its input", LIMIT, async () => {
    const f = await fixture("exit 3\n");
    // Larger than a pipe buffer, so the write is still pending when the launcher exits.
    const result = await runDoctor(f, { version: "1".repeat(1_000_000) });
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} exited with code 3 before answering; ${SETUP}`,
    ]);
  });

  it("stops waiting for a launcher whose child holds its output", LIMIT, async () => {
    const f = await fixture('sleep 30 &\necho $! > "$HOME/child.pid"\nexec sleep 30\n');
    const started = performance.now();
    const result = await runDoctor(f, { timeouts: SHORT });
    process.kill(Number(readFileSync(path.join(f.home, "child.pid"), "utf8")));
    assert.ok(performance.now() - started < 3000);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} did not answer within 0.3 s; ${SETUP}`,
    ]);
  });

  it("kills a launcher that never answers", LIMIT, async () => {
    const f = await fixture("exec sleep 30\n");
    const recorder = recordingSpawn();
    const started = performance.now();
    const result = await runDoctor(f, { spawn: recorder.spawn, timeouts: SHORT });
    assert.ok(performance.now() - started < 3000);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} did not answer within 0.3 s; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
    assert.equal(recorder.calls[0]?.child?.signalCode, "SIGTERM");
    assert.equal(existsSync(runtimeDir(recorder)), false);
  });

  it("kills a launcher that ignores SIGTERM with SIGKILL", LIMIT, async () => {
    const f = await fixture(`trap '' TERM\n${printfFrame(launcherWelcome())}\nexec sleep 30\n`);
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn, timeouts: SHORT });
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} did not exit within 0.3 s after its input closed; ${SETUP}`,
    ]);
    assert.equal(recorder.calls[0]?.child?.signalCode, "SIGKILL");
    assert.equal(existsSync(runtimeDir(recorder)), false);
  });

  it("kills a launcher that answers but does not exit", LIMIT, async () => {
    const f = await fixture(`${printfFrame(launcherWelcome())}\nexec sleep 30\n`);
    const recorder = recordingSpawn();
    const started = performance.now();
    const result = await runDoctor(f, { spawn: recorder.spawn, timeouts: SHORT });
    assert.ok(performance.now() - started < 3000);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} did not exit within 0.3 s after its input closed; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
    assert.equal(recorder.calls[0]?.child?.signalCode, "SIGTERM");
    assert.equal(existsSync(runtimeDir(recorder)), false);
  });

  it("fails a launcher that exits non-zero after answering", LIMIT, async () => {
    const f = await fixture(`${printfFrame(launcherWelcome())}\ncat > /dev/null\nexit 4\n`);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} exited with code 4 after answering; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
  });

  it("names the signal that ended a launcher", LIMIT, async () => {
    const f = await fixture("kill -KILL $$\n");
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} exited with signal SIGKILL before answering; ${SETUP}`,
    ]);
  });

  it("fails a launcher that answers with something else", LIMIT, async () => {
    const f = await fixture(`${printfFrame({})}\nexec cat > /dev/null\n`);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} did not answer with a welcome; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
  });

  it("fails a launcher that answers with an unreadable frame", LIMIT, async () => {
    const f = await fixture(`${printfBytes(encodeFrame("{"))}\nexec cat > /dev/null\n`);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} did not answer with a welcome; ${SETUP}`,
    ]);
  });

  it("judges the first frame only", LIMIT, async () => {
    const f = await fixture(
      `${printfFrame({})}\nsleep 0.2\n${printfFrame(launcherWelcome())}\nexec cat > /dev/null\n`,
    );
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} did not answer with a welcome; ${SETUP}`,
    ]);
  });

  it("waits for a welcome split across writes", LIMIT, async () => {
    const frame = encodeFrame(JSON.stringify(launcherWelcome()));
    const f = await fixture(
      `${printfBytes(frame.subarray(0, 6))}\nsleep 0.2\n${printfBytes(frame.subarray(6))}\nexec cat > /dev/null\n`,
    );
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [launcherOk(f)]);
  });

  it("reports a launcher without its exec bit, without a stack trace", LIMIT, async () => {
    const f = await fixture();
    chmodSync(f.launcher, 0o644);
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: cannot run ${f.launcher}: EACCES; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
    for (const line of result.lines) {
      assert.ok(!line.includes("    at ") && !line.includes("Error"), line);
    }
    assert.equal(existsSync(runtimeDir(recorder)), false);
  });

  it("reports a launcher that spawn refuses at once", LIMIT, async () => {
    const f = await fixture();
    writeFileSync(f.launcher, `#!${f.launcher}\n`);
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: cannot run ${f.launcher}: ELOOP; ${SETUP}`,
      `warn launcher: the launcher runs #!${f.launcher}; run npm run setup to switch`,
    ]);
    assert.equal(result.code, 1);
    assert.equal(existsSync(runtimeDir(recorder)), false);
  });

  it("names the error code of any spawn failure", LIMIT, async () => {
    const f = await fixture();
    const spawns: Spawn[] = [
      () => {
        throw new Error("no code");
      },
      () => {
        throw Object.assign(new Error("numeric"), { code: 7 });
      },
    ];
    for (const failing of spawns) {
      const result = await runDoctor(f, { spawn: failing });
      assert.deepEqual(section(result, ["launcher"]), [
        `FAIL launcher: cannot run ${f.launcher}: UNKNOWN; ${SETUP}`,
      ]);
    }
  });

  it("fails a missing launcher without running anything", LIMIT, async () => {
    const f = await fixture();
    const missing = path.join(f.home, "missing-launcher");
    rewriteManifest(f, { path: missing });
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(section(result, ["native manifest", "launcher"]), [
      `ok native manifest: ${f.manifest}`,
      `FAIL launcher: ${missing} does not exist; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
    assert.equal(recorder.calls.length, 0);
  });

  it("fails a directory at the launcher path", LIMIT, async () => {
    const f = await fixture();
    rewriteManifest(f, { path: f.home });
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.home} is not a regular file; ${SETUP}`,
    ]);
    assert.equal(recorder.calls.length, 0);
  });

  it("fails a launcher it cannot read", LIMIT, async () => {
    const f = await fixture();
    chmodSync(f.launcher, 0);
    const recorder = recordingSpawn();
    const result = await runDoctor(f, { spawn: recorder.spawn });
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} cannot be read: EACCES; ${SETUP}`,
    ]);
    assert.equal(result.code, 1);
    assert.equal(recorder.calls.length, 0);
  });

  it("warns when it cannot remove the runtime directory", LIMIT, async () => {
    const f = await fixture(
      [
        'mkdir "$XDG_RUNTIME_DIR/x"',
        ': > "$XDG_RUNTIME_DIR/x/f"',
        'chmod 500 "$XDG_RUNTIME_DIR/x"',
        printfFrame(launcherWelcome()),
        "exec cat > /dev/null",
        "",
      ].join("\n"),
    );
    const recorder = recordingSpawn();
    await fakeHost(f.socketDir, process.pid);
    try {
      const result = await runDoctor(f, { spawn: recorder.spawn });
      assert.deepEqual(section(result, ["launcher"]), [
        launcherOk(f),
        `warn launcher: cannot remove ${runtimeDir(recorder)}: EACCES`,
      ]);
      assert.equal(result.code, 0);
    } finally {
      // Outside root, so after() would not remove it.
      const xdg = recorder.calls[0]?.options.env?.XDG_RUNTIME_DIR;
      if (xdg !== undefined && existsSync(path.join(xdg, "x"))) {
        chmodSync(path.join(xdg, "x"), 0o700);
      }
      if (xdg !== undefined) {
        rmSync(xdg, { recursive: true, force: true });
      }
    }
  });

  it("says an empty launcher runs nothing", LIMIT, async () => {
    const f = await fixture();
    writeFileSync(f.launcher, "");
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      `FAIL launcher: ${f.launcher} exited with code 0 before answering; ${SETUP}`,
      "warn launcher: the launcher runs nothing; run npm run setup to switch",
    ]);
  });

  it("cuts a long launcher line at 200 characters", LIMIT, async () => {
    const f = await fixture();
    const tail = `cat > /dev/null #${"x".repeat(300)}`;
    writeFileSync(
      f.launcher,
      `#!/bin/sh\n${printfFrame(launcherWelcome())}\n  exec ${tail}  \n\n  \n`,
    );
    await fakeHost(f.socketDir, process.pid);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      launcherOk(f),
      `warn launcher: the launcher runs ${tail.slice(0, 200)}...; run npm run setup to switch`,
    ]);
    assert.equal(result.code, 0);
  });

  it("keeps a launcher line of exactly 200 characters whole", LIMIT, async () => {
    const f = await fixture();
    const tail = `#${"x".repeat(199)}`;
    writeFileSync(
      f.launcher,
      `#!/bin/sh\n${printfFrame(launcherWelcome())}\ncat >/dev/null\n${tail}\n`,
    );
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      launcherOk(f),
      `warn launcher: the launcher runs ${tail}; run npm run setup to switch`,
    ]);
  });

  it("fails a launcher on another protocol", LIMIT, async () => {
    const other = PROTOCOL_VERSION + 1;
    const f = await fixture(answering(launcherWelcome(other)));
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["launcher"]), [
      `ok launcher: ${f.launcher} runs host version ${HOST_VERSION}, protocol ${other}`,
      `FAIL launcher: ${protocolMismatch(
        { part: "host", protocol: other, version: HOST_VERSION },
        { part: "mcp", protocol: PROTOCOL_VERSION, version: VERSION },
      )}`,
    ]);
    assert.equal(result.code, 1);
  });

  it("warns about a launcher for another checkout", LIMIT, async () => {
    const f = await fixture();
    const otherMain = path.join(f.home, "other main.sh");
    writeFileSync(otherMain, answering(launcherWelcome()));
    await install({
      home: f.home,
      node: SH,
      program: { kind: "source", main: otherMain },
      ...quiet(),
    });
    const host = await fakeHost(f.socketDir, process.pid);
    const result = await runDoctor(f);
    assert.deepEqual(result.lines, [
      `ok native manifest: ${f.manifest}`,
      launcherOk(f),
      `warn launcher: the launcher runs '${SH}' '${otherMain}' host; run npm run setup to switch`,
      ...claudeLines(f),
      `ok socket directory: ${f.socketDir}`,
      hostOk(host, process.pid),
      extensionOk(),
      PERMISSION_OK,
      "8 checks, 0 failed",
    ]);
    assert.equal(result.code, 0);
  });
});

describe("doctor, the setup command it names", () => {
  it("names the setup command it is given", LIMIT, async () => {
    const f = await fixture();
    unlinkSync(f.manifest);
    const result = await runDoctor(f, { setupCommand: SETUP_COMMAND });
    assert.deepEqual(section(result, ["native manifest"]), [
      `FAIL native manifest: ${f.manifest} does not exist; run ${SETUP_COMMAND}`,
    ]);
  });

  it("expects the installed copy after a setup from the bundle", LIMIT, async () => {
    const f = await fixture();
    const bundle = path.join(f.home, "bundle.sh");
    writeFileSync(bundle, answering(launcherWelcome()));
    await install({
      home: f.home,
      node: SH,
      program: { kind: "bundle", file: bundle },
      ...quiet(),
    });
    const copy = installPaths(f.home).program;
    const result = await runDoctor(f, {
      main: copy,
      setupCommand: SETUP_COMMAND,
      run: fakeRun(claudeOk(SH, copy)).run,
    });
    assert.deepEqual(section(result, ["launcher", "claude code"]), [
      launcherOk(f),
      "ok claude code: foxleash is registered",
      `  Command: ${SH}`,
      `  Args: ${copy} mcp`,
    ]);
  });
});

describe("doctor, Claude Code", () => {
  it("asks claude mcp get for foxleash with a 15 s limit", LIMIT, async () => {
    const f = await fixture();
    const claude = fakeRun(claudeOk(SH, f.main));
    const result = await runDoctor(f, { run: claude.run });
    assert.deepEqual(claude.calls, [
      { command: "claude", args: ["mcp", "get", "foxleash"], options: { timeoutMs: 15_000 } },
    ]);
    assert.deepEqual(section(result, ["claude code"]), claudeLines(f));
  });

  it("warns when the registration runs something else", LIMIT, async () => {
    const f = await fixture();
    const claude = fakeRun(claudeOk("npx", "chrome-devtools-mcp@latest"));
    const result = await runDoctor(f, { run: claude.run });
    assert.deepEqual(section(result, ["claude code"]), [
      `warn claude code: registered as npx chrome-devtools-mcp@latest mcp, expected ${SH} ${f.main} mcp; ${SETUP}`,
    ]);
  });

  it("shows the one line it found", LIMIT, async () => {
    const f = await fixture();
    for (const [stdout, line] of [
      ["foxleash:\n  Command: npx\n", "  Command: npx"],
      ["foxleash:\n  Args: x y\n", "  Args: x y"],
    ] as const) {
      const claude = fakeRun({ status: "ok", code: 0, stdout, stderr: "" });
      const result = await runDoctor(f, { run: claude.run });
      assert.deepEqual(section(result, ["claude code"]), [
        "ok claude code: foxleash is registered",
        line,
      ]);
    }
  });

  it("shows no lines when it found none, and uses the first of each", LIMIT, async () => {
    const f = await fixture();
    const none = fakeRun({ status: "ok", code: 0, stdout: "foxleash:\n", stderr: "" });
    assert.deepEqual(section(await runDoctor(f, { run: none.run }), ["claude code"]), [
      "ok claude code: foxleash is registered",
    ]);
    const twice = fakeRun({
      status: "ok",
      code: 0,
      stdout: `Command:   ${SH}  \nArgs: ${f.main} mcp\nCommand: npx\nArgs: other\n`,
      stderr: "",
    });
    assert.deepEqual(
      section(await runDoctor(f, { run: twice.run }), ["claude code"]),
      claudeLines(f),
    );
  });

  const others: [RunResult, string][] = [
    [
      { status: "failed", code: 1, stdout: "", stderr: "" },
      `FAIL claude code: not registered; ${SETUP}`,
    ],
    [{ status: "missing" }, "warn claude code: claude is not on PATH; skipped"],
    [{ status: "timeout" }, "warn claude code: claude mcp get did not finish in 15 s"],
  ];
  for (const [answer, line] of others) {
    it(`reports claude mcp get ${answer.status}`, LIMIT, async () => {
      const f = await fixture();
      const host = await fakeHost(f.socketDir, process.pid);
      const failed = answer.status === "failed" ? 1 : 0;
      const result = await runDoctor(f, { run: fakeRun(answer).run });
      assert.deepEqual(result.lines, [
        `ok native manifest: ${f.manifest}`,
        launcherOk(f),
        line,
        `ok socket directory: ${f.socketDir}`,
        hostOk(host, process.pid),
        extensionOk(),
        PERMISSION_OK,
        `7 checks, ${failed} failed`,
      ]);
      assert.equal(result.code, failed);
    });
  }
});

describe("doctor, the socket directory", () => {
  it("fails a missing directory and skips the hosts", LIMIT, async () => {
    const f = await fixture();
    const missing = path.join(root, "no-such-dir");
    const result = await runDoctor(f, { socketDir: missing });
    assert.deepEqual(result.lines, [
      `ok native manifest: ${f.manifest}`,
      launcherOk(f),
      ...claudeLines(f),
      `FAIL socket directory: no host has started yet in ${missing}; is Firefox running with the Foxleash extension?`,
      "4 checks, 1 failed",
    ]);
    assert.equal(result.code, 1);
  });

  it("adds the Flatpak step to a missing directory", LIMIT, async () => {
    const f = await fixture();
    const missing = path.join(root, "no-such-dir-flatpak");
    addFlatpakFirefox(f);
    const result = await runDoctor(f, { socketDir: missing });
    assert.deepEqual(result.lines, [
      `ok native manifest: ${f.manifest}`,
      launcherOk(f),
      ...claudeLines(f),
      `FAIL socket directory: no host has started yet in ${missing}; is Firefox running with the Foxleash extension?`,
      ...flatpakLines(f),
      "4 checks, 1 failed",
    ]);
    assert.equal(result.code, 1);
  });

  it("fails a directory open to others and skips the hosts", LIMIT, async () => {
    const f = await fixture();
    await fakeHost(f.socketDir, process.pid);
    chmodSync(f.socketDir, 0o755);
    const result = await runDoctor(f);
    chmodSync(f.socketDir, 0o700);
    assert.deepEqual(section(result, ["socket directory", "hosts", "extension"]), [
      `FAIL socket directory: ${f.socketDir} is open to other users (mode 0755); remove it and restart Firefox`,
    ]);
    assert.equal(result.lines.at(-1), "4 checks, 1 failed");
  });

  it("leaves the Flatpak step out when the directory is open to others", LIMIT, async () => {
    const f = await fixture();
    addFlatpakFirefox(f);
    await fakeHost(f.socketDir, process.pid);
    chmodSync(f.socketDir, 0o755);
    const result = await runDoctor(f);
    chmodSync(f.socketDir, 0o700);
    assert.deepEqual(result.lines.slice(-2), [
      `FAIL socket directory: ${f.socketDir} is open to other users (mode 0755); remove it and restart Firefox`,
      "4 checks, 1 failed",
    ]);
  });

  it("warns about each skipped candidate first", LIMIT, async () => {
    const f = await fixture();
    await fakeHost(f.socketDir, process.pid);
    const skipped = ["XDG_RUNTIME_DIR is empty", "/run/user/1000 does not exist"];
    const result = await runDoctor(f, { skipped });
    assert.deepEqual(section(result, ["socket directory"]), [
      "warn socket directory: skipped XDG_RUNTIME_DIR is empty",
      "warn socket directory: skipped /run/user/1000 does not exist",
      `ok socket directory: ${f.socketDir}`,
    ]);
    assert.equal(result.code, 0);
  });
});

describe("doctor, the hosts", () => {
  it("fails a socket directory it cannot list", LIMIT, async () => {
    const f = await fixture();
    chmodSync(f.socketDir, 0o300);
    const result = await runDoctor(f);
    chmodSync(f.socketDir, 0o700);
    assert.deepEqual(section(result, ["socket directory", "hosts"]), [
      `ok socket directory: ${f.socketDir}`,
      `FAIL hosts: The Foxleash socket directory ${f.socketDir} cannot be read: EACCES; remove it, or set XDG_RUNTIME_DIR to a private directory, and try again.`,
    ]);
    assert.equal(result.code, 1);
  });

  it("leaves the Flatpak step out when it cannot list the directory", LIMIT, async () => {
    const f = await fixture();
    addFlatpakFirefox(f);
    chmodSync(f.socketDir, 0o300);
    const result = await runDoctor(f);
    chmodSync(f.socketDir, 0o700);
    assert.ok(
      result.lines.every((line) => !line.includes("Flatpak")),
      result.lines.join("\n"),
    );
    assert.equal(result.code, 1);
  });

  it("fails with only a socket of a dead process", LIMIT, async () => {
    const f = await fixture();
    const stale = await staleSocket(f.socketDir, DEAD_PID);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [
      `warn host ${stale}: stale (no process ${DEAD_PID})`,
      noHost(f),
    ]);
    assert.equal(result.code, 1);
  });

  it("fails with only a socket nothing listens on", LIMIT, async () => {
    const f = await fixture();
    const stale = await staleSocket(f.socketDir, process.pid);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [
      `warn host ${stale}: stale (nothing listening)`,
      noHost(f),
    ]);
    assert.equal(result.code, 1);
  });

  it("fails with an empty directory", LIMIT, async () => {
    const f = await fixture();
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [noHost(f)]);
    assert.equal(result.code, 1);
  });

  it("adds the Flatpak step to an empty directory", LIMIT, async () => {
    const f = await fixture();
    addFlatpakFirefox(f);
    const result = await runDoctor(f);
    assert.deepEqual(result.lines.slice(result.lines.indexOf(noHost(f))), [
      noHost(f),
      ...flatpakLines(f),
      "5 checks, 1 failed",
    ]);
    assert.equal(result.code, 1);
  });

  it("leaves the Flatpak step out when a host answers", LIMIT, async () => {
    const f = await fixture();
    addFlatpakFirefox(f);
    const host = await fakeHost(f.socketDir, process.pid);
    const result = await runDoctor(f);
    assert.deepEqual(result.lines, [...allOk(f, host), "7 checks, 0 failed"]);
    assert.equal(result.code, 0);
  });

  it("ignores a file where the Flatpak folder would be", LIMIT, async () => {
    const f = await fixture();
    mkdirSync(path.join(f.home, ".var/app"), { recursive: true });
    writeFileSync(path.join(f.home, FLATPAK_FIREFOX), "");
    const result = await runDoctor(f);
    assert.ok(
      result.lines.every((line) => !line.includes("Flatpak")),
      result.lines.join("\n"),
    );
    assert.equal(result.lines.at(-1), "5 checks, 1 failed");
    assert.equal(result.code, 1);
  });

  it("passes with a stale socket next to an answering host", LIMIT, async () => {
    const f = await fixture();
    const host = await fakeHost(f.socketDir, process.pid);
    age(host.path, 100);
    const stale = await staleSocket(f.socketDir, process.ppid);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [
      `warn host ${stale}: stale (nothing listening)`,
      hostOk(host, process.pid),
      extensionOk(),
      PERMISSION_OK,
    ]);
    assert.equal(result.code, 0);
  });

  it("fails a host that does not answer with a welcome", LIMIT, async () => {
    const f = await fixture();
    const host = await fakeHost(f.socketDir, process.pid, { type: "nope" });
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [
      `FAIL host ${host.path}: The Foxleash native host at ${host.path} did not answer with a welcome.`,
      noHost(f),
    ]);
    assert.equal(result.code, 1);
  });

  it("fails a host socket it may not connect to", LIMIT, async () => {
    const f = await fixture();
    const host = await fakeHost(f.socketDir, process.pid);
    chmodSync(host.path, 0);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [
      `FAIL host ${host.path}: EACCES`,
      noHost(f),
    ]);
    assert.equal(result.code, 1);
  });

  it("calls a socket that vanished before the connect stale", LIMIT, async () => {
    const f = await fixture();
    const older = await staleSocket(f.socketDir, process.ppid);
    age(older, 100);
    const newer = path.join(f.socketDir, `${process.pid}.sock`);
    const server = net.createServer((socket) => {
      unlinkSync(older);
      const reader = createFrameReader(FRAME_LIMIT);
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => {
        if (reader.push(chunk).length > 0) {
          socket.write(encodeFrame(JSON.stringify(hostWelcome())));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(newer, resolve));
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [
      `ok host ${newer} (pid ${process.pid}): version ${HOST_VERSION}, protocol ${PROTOCOL_VERSION}`,
      extensionOk(),
      PERMISSION_OK,
      `warn host ${older}: stale (the socket is gone)`,
    ]);
    assert.equal(result.code, 0);
  });

  it("fails a host on another protocol", LIMIT, async () => {
    const f = await fixture();
    const other = PROTOCOL_VERSION + 1;
    const host = await fakeHost(f.socketDir, process.pid, hostWelcome(connected(), other));
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [
      hostOk(host, process.pid, other),
      `FAIL host ${host.path}: ${protocolMismatch(
        { part: "mcp", protocol: PROTOCOL_VERSION, version: VERSION },
        { part: "host", protocol: other, version: HOST_VERSION },
      )}`,
      `ok extension: version ${EXTENSION_VERSION}, protocol ${PROTOCOL_VERSION}`,
      `FAIL extension: ${protocolMismatch(
        { part: "extension", protocol: PROTOCOL_VERSION, version: EXTENSION_VERSION },
        { part: "host", protocol: other, version: HOST_VERSION },
      )}`,
      PERMISSION_OK,
    ]);
    assert.equal(result.code, 1);
  });

  it("lists each host's extension under that host", LIMIT, async () => {
    const f = await fixture();
    const older = await fakeHost(
      f.socketDir,
      process.ppid,
      hostWelcome({ connected: true, protocol: PROTOCOL_VERSION, version: "0.8.0" }),
    );
    age(older.path, 100);
    const newer = await fakeHost(f.socketDir, process.pid);
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["hosts", "extension"]), [
      hostOk(newer, process.pid),
      extensionOk(),
      PERMISSION_OK,
      hostOk(older, process.ppid),
      `ok extension: version 0.8.0, protocol ${PROTOCOL_VERSION}`,
      `warn extension: ${versionDifference(
        { part: "extension", protocol: PROTOCOL_VERSION, version: "0.8.0" },
        { part: "host", protocol: PROTOCOL_VERSION, version: HOST_VERSION },
      )}`,
      "warn extension permissions: not reported by this extension version",
    ]);
    assert.equal(result.code, 0);
  });
});

describe("doctor, the extension", () => {
  const notConnected: [string, unknown][] = [
    ["disconnected", { connected: false }],
    ["absent", undefined],
  ];
  for (const [name, extension] of notConnected) {
    it(`fails an extension that is ${name}`, LIMIT, async () => {
      const f = await fixture();
      const welcome = { type: "welcome", protocol: PROTOCOL_VERSION, version: HOST_VERSION };
      const host = await fakeHost(
        f.socketDir,
        process.pid,
        extension === undefined ? welcome : { ...welcome, extension },
      );
      const result = await runDoctor(f);
      assert.deepEqual(section(result, ["hosts", "extension"]), [
        hostOk(host, process.pid),
        `FAIL extension: not connected to the host at ${host.path}; is the Foxleash extension installed and enabled?`,
      ]);
      assert.equal(result.code, 1);
    });
  }

  it("fails an extension on another protocol", LIMIT, async () => {
    const f = await fixture();
    const other = PROTOCOL_VERSION + 1;
    await fakeHost(
      f.socketDir,
      process.pid,
      hostWelcome({ connected: true, protocol: other, version: EXTENSION_VERSION, allUrls: true }),
    );
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["extension"]), [
      `ok extension: version ${EXTENSION_VERSION}, protocol ${other}`,
      `FAIL extension: ${protocolMismatch(
        { part: "extension", protocol: other, version: EXTENSION_VERSION },
        { part: "host", protocol: PROTOCOL_VERSION, version: HOST_VERSION },
      )}`,
      PERMISSION_OK,
    ]);
    assert.equal(result.code, 1);
  });

  it("accepts a newer extension that serves the host's protocol", LIMIT, async () => {
    const f = await fixture();
    const newer = PROTOCOL_VERSION + 1;
    await fakeHost(
      f.socketDir,
      process.pid,
      hostWelcome({
        connected: true,
        protocol: newer,
        version: EXTENSION_VERSION,
        allUrls: true,
        oldestProtocol: PROTOCOL_VERSION,
      }),
    );
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["extension"]), [
      `ok extension: version ${EXTENSION_VERSION}, protocol ${newer}, which works with protocol ${PROTOCOL_VERSION} and later`,
      PERMISSION_OK,
    ]);
    assert.equal(result.code, 0);
  });

  it("fails a newer extension that no longer serves the host's protocol", LIMIT, async () => {
    const f = await fixture();
    const newer = PROTOCOL_VERSION + 2;
    const oldest = PROTOCOL_VERSION + 1;
    await fakeHost(
      f.socketDir,
      process.pid,
      hostWelcome({
        connected: true,
        protocol: newer,
        version: EXTENSION_VERSION,
        allUrls: true,
        oldestProtocol: oldest,
      }),
    );
    const result = await runDoctor(f);
    const window = `version ${EXTENSION_VERSION}, protocol ${newer}, which works with protocol ${oldest} and later`;
    assert.deepEqual(section(result, ["extension"]), [
      `ok extension: ${window}`,
      `FAIL extension: The Foxleash native host (version ${HOST_VERSION}, protocol ${PROTOCOL_VERSION}) is older than the Foxleash extension (${window}): Firefox is still running the old native host, so update Foxleash with \`npx foxleash@latest setup\` if you have not yet and then restart Firefox.`,
      PERMISSION_OK,
    ]);
    assert.equal(result.code, 1);
  });

  it("fails an older extension whatever protocols it serves", LIMIT, async () => {
    const f = await fixture();
    const older = PROTOCOL_VERSION - 1;
    await fakeHost(
      f.socketDir,
      process.pid,
      hostWelcome({
        connected: true,
        protocol: older,
        version: EXTENSION_VERSION,
        allUrls: true,
        oldestProtocol: older,
      }),
    );
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["extension"]), [
      `ok extension: version ${EXTENSION_VERSION}, protocol ${older}`,
      `FAIL extension: The Foxleash extension (version ${EXTENSION_VERSION}, protocol ${older}) is older than the Foxleash native host (version ${HOST_VERSION}, protocol ${PROTOCOL_VERSION}): update the add-on in Firefox (open about:addons and choose Check for Updates), or install it again from ${ADDON_PAGE_URL}.`,
      PERMISSION_OK,
    ]);
    assert.equal(result.code, 1);
  });

  it(
    "warns that an extension of another version on the same protocol is older",
    LIMIT,
    async () => {
      const f = await fixture();
      await fakeHost(
        f.socketDir,
        process.pid,
        hostWelcome({
          connected: true,
          protocol: PROTOCOL_VERSION,
          version: "1.9.0",
          allUrls: true,
        }),
      );
      const result = await runDoctor(f);
      assert.deepEqual(section(result, ["extension"]), [
        `ok extension: version 1.9.0, protocol ${PROTOCOL_VERSION}`,
        `warn extension: The Foxleash extension (version 1.9.0) is older than the Foxleash native host (version ${HOST_VERSION}): update the add-on in Firefox (open about:addons and choose Check for Updates), or install it again from ${ADDON_PAGE_URL}.`,
        PERMISSION_OK,
      ]);
      assert.equal(result.code, 0);
    },
  );

  it("warns that a host older than its extension needs a program update", LIMIT, async () => {
    const f = await fixture();
    await fakeHost(
      f.socketDir,
      process.pid,
      hostWelcome({ connected: true, protocol: PROTOCOL_VERSION, version: "2.1.0", allUrls: true }),
    );
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["extension"]), [
      `ok extension: version 2.1.0, protocol ${PROTOCOL_VERSION}`,
      `warn extension: The Foxleash native host (version ${HOST_VERSION}) is older than the Foxleash extension (version 2.1.0): Firefox is still running the old native host, so update Foxleash with \`npx foxleash@latest setup\` if you have not yet and then restart Firefox.`,
      PERMISSION_OK,
    ]);
    assert.equal(result.code, 0);
  });

  it("fails an extension without access to all websites", LIMIT, async () => {
    const f = await fixture();
    await fakeHost(f.socketDir, process.pid, hostWelcome(connected(false)));
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["extension", "extension permissions"]), [
      extensionOk(),
      'FAIL extension permissions: access to all websites is not granted; open about:addons in Firefox, click Foxleash, then the Permissions tab, and under "Optional" turn on "Access your data for all websites"',
    ]);
    assert.equal(result.code, 1);
  });

  it("warns when the extension does not report its access", LIMIT, async () => {
    const f = await fixture();
    await fakeHost(f.socketDir, process.pid, hostWelcome(connected(null)));
    const result = await runDoctor(f);
    assert.deepEqual(section(result, ["extension", "extension permissions"]), [
      extensionOk(),
      "warn extension permissions: not reported by this extension version",
    ]);
    assert.equal(result.code, 0);
  });
});

describe("doctor, output", () => {
  it("escapes control characters from outside text", LIMIT, async () => {
    const f = await fixture();
    const odd = path.join(f.home, "x\u001b[31m\nred\u009b");
    rewriteManifest(f, { path: odd });
    const claude = fakeRun({
      status: "ok",
      code: 0,
      stdout: "  Command: \u001b[31mnode\u0007\n  Args: x\n",
      stderr: "",
    });
    const result = await runDoctor(f, { run: claude.run });
    const shown = odd
      .replace("\u001b", "\\u001b")
      .replace("\n", "\\u000a")
      .replace("\u009b", "\\u009b");
    assert.deepEqual(section(result, ["launcher", "claude code"]), [
      `FAIL launcher: ${shown} does not exist; ${SETUP}`,
      `warn claude code: registered as \\u001b[31mnode\\u0007 x, expected ${SH} ${f.main} mcp; ${SETUP}`,
    ]);
  });
});

async function runDoctor(f: Fixture, overrides: Partial<DoctorOptions> = {}): Promise<Result> {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk: unknown, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const before = leftovers();
  const code = await doctor({
    home: f.home,
    socketDir: f.socketDir,
    skipped: [],
    uid,
    version: VERSION,
    node: SH,
    main: f.main,
    setupCommand: "npm run setup",
    run: fakeRun(claudeOk(SH, f.main)).run,
    spawn,
    out,
    ...overrides,
  });
  assert.deepEqual(leftovers(), before, "the doctor left a timer behind");
  const text = chunks.join("");
  assert.ok(!text.includes("\u001b"), text);
  assert.ok(text.endsWith("\n"), text);
  const lines = text.slice(0, -1).split("\n");
  assertShape(lines, code);
  return { code, lines };
}

function leftovers(): string[] {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout");
}

// Every line is a status line, a continuation of the Claude Code line or of a no-host FAIL line,
// or the summary.
function assertShape(lines: string[], code: number): void {
  const statuses = lines.slice(0, -1);
  let continues = false;
  for (const line of statuses) {
    if (line.startsWith("  ")) {
      assert.ok(continues, line);
      continue;
    }
    assert.match(line, /^(ok|warn|FAIL) [^:]+: /);
    continues =
      line === "ok claude code: foxleash is registered" ||
      line.startsWith("FAIL socket directory: no host has started yet ") ||
      line.startsWith("FAIL hosts: no running host answered ");
  }
  const checks = statuses.filter((line) => !line.startsWith("  "));
  const failed = checks.filter((line) => line.startsWith("FAIL ")).length;
  assert.equal(lines.at(-1), `${checks.length} checks, ${failed} failed`);
  assert.equal(code, failed > 0 ? 1 : 0);
}

function section(result: Result, checks: string[]): string[] {
  return result.lines.filter((line) => {
    const match = /^(?:ok|warn|FAIL) (.+?)(?: \(pid \d+\))?: /.exec(line);
    const check = match?.[1] ?? "";
    const name = check.startsWith("host ") ? "hosts" : check;
    return (
      checks.some((wanted) => name === wanted || name.startsWith(`${wanted} `)) ||
      (checks.includes("claude code") && line.startsWith("  "))
    );
  });
}

async function fixture(script = answering(launcherWelcome())): Promise<Fixture> {
  const home = privateDir();
  const main = path.join(home, "fake-main.sh");
  writeFileSync(main, script);
  await install({ home, node: SH, program: { kind: "source", main }, ...quiet() });
  const { launcher, manifest } = installPaths(home);
  return { home, main, manifest, launcher, socketDir: privateDir() };
}

function quiet(): {
  claude: false;
  extension: ExtensionSource;
  run: Run;
  launch: Launch;
  out: Writable;
  uid: number;
} {
  return {
    claude: false,
    extension: { kind: "none" },
    run: fakeRun({ status: "missing" }).run,
    launch: async () => assert.fail("launch called"),
    out: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    uid,
  };
}

function privateDir(): string {
  counter += 1;
  const dir = path.join(root, `d${counter}`);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function rewriteManifest(f: Fixture, changes: Record<string, unknown>): void {
  const value: unknown = JSON.parse(readFileSync(f.manifest, "utf8"));
  assert.ok(typeof value === "object" && value !== null);
  writeFileSync(f.manifest, JSON.stringify({ ...value, ...changes }));
}

// The fast fake host program: answers like the real host and keeps what it was sent.
function answering(welcome: unknown): string {
  return `${printfFrame(welcome)}\nexec cat > "$HOME/stdin.bin"\n`;
}

function printfFrame(value: unknown): string {
  return printfBytes(encodeFrame(JSON.stringify(value)));
}

function printfBytes(bytes: Buffer): string {
  const escaped = [...bytes].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
  return `printf '${escaped}'`;
}

function launcherWelcome(protocol = PROTOCOL_VERSION): unknown {
  return { type: "welcome", protocol, version: HOST_VERSION };
}

// null leaves allUrls out, as an older extension does.
function connected(allUrls: boolean | null = true): unknown {
  const extension = { connected: true, protocol: PROTOCOL_VERSION, version: EXTENSION_VERSION };
  return allUrls === null ? extension : { ...extension, allUrls };
}

function hostWelcome(extension: unknown = connected(), protocol = PROTOCOL_VERSION): unknown {
  return { type: "welcome", protocol, version: HOST_VERSION, extension };
}

async function fakeHost(dir: string, pid: number, welcome = hostWelcome()): Promise<FakeHost> {
  const host = await startFakeHost({ dir, pid, welcome, respond: () => undefined });
  hosts.push(host);
  return host;
}

function fakeRun(result: RunResult): { run: Run; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    calls,
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return result;
    },
  };
}

function claudeOk(node: string, main: string): RunResult {
  return {
    status: "ok",
    code: 0,
    stdout: `foxleash:\n  Scope: User config\n  Type: stdio\n  Command: ${node}\n  Args: ${main} mcp\n  Environment:\n`,
    stderr: "",
  };
}

function recordingSpawn(): SpawnRecorder {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (command, args, options) => {
      // Copied: spawn adds NODE_V8_COVERAGE to the env object it is given when coverage is on.
      const call: SpawnCall = {
        command,
        args,
        options: { ...options, env: { ...options.env } },
        child: undefined,
      };
      calls.push(call);
      call.child = spawn(command, args, options);
      return call.child;
    },
  };
}

function runtimeDir(recorder: SpawnRecorder): string {
  const dir = recorder.calls[0]?.options.env?.XDG_RUNTIME_DIR;
  assert.ok(dir !== undefined, "the launcher was not run");
  return dir;
}

function allOk(f: Fixture, host: FakeHost): string[] {
  return [
    `ok native manifest: ${f.manifest}`,
    launcherOk(f),
    ...claudeLines(f),
    `ok socket directory: ${f.socketDir}`,
    hostOk(host, process.pid),
    extensionOk(),
    PERMISSION_OK,
  ];
}

function launcherOk(f: Fixture): string {
  return `ok launcher: ${f.launcher} runs host version ${HOST_VERSION}, protocol ${PROTOCOL_VERSION}`;
}

function claudeLines(f: Fixture): string[] {
  return ["ok claude code: foxleash is registered", `  Command: ${SH}`, `  Args: ${f.main} mcp`];
}

function hostOk(host: FakeHost, pid: number, protocol = PROTOCOL_VERSION): string {
  return `ok host ${host.path} (pid ${pid}): version ${HOST_VERSION}, protocol ${protocol}`;
}

function extensionOk(): string {
  return `ok extension: version ${EXTENSION_VERSION}, protocol ${PROTOCOL_VERSION}`;
}

function noHost(f: Fixture): string {
  return `FAIL hosts: no running host answered in ${f.socketDir}; is Firefox running with the Foxleash extension?`;
}

function addFlatpakFirefox(f: Fixture): void {
  mkdirSync(path.join(f.home, FLATPAK_FIREFOX), { recursive: true });
}

function flatpakLines(f: Fixture): string[] {
  return [
    `  Firefox from Flatpak is installed (${path.join(f.home, FLATPAK_FIREFOX)}). It starts the`,
    "  Foxleash host only after one setting: open about:config in that Firefox, set",
    "  widget.use-xdg-desktop-portal.native-messaging to 2, and click Allow when it asks to",
    "  start the WebExtension backend. The README's install section has the steps.",
  ];
}

function age(socketPath: string, seconds: number): void {
  const time = Date.now() / 1000 - seconds;
  utimesSync(socketPath, time, time);
}

async function staleSocket(dir: string, pid: number): Promise<string> {
  const server = net.createServer();
  const temporary = path.join(dir, "binding");
  await new Promise<void>((resolve) => server.listen(temporary, resolve));
  const target = path.join(dir, `${pid}.sock`);
  renameSync(temporary, target);
  await new Promise((resolve) => server.close(resolve));
  return target;
}

function currentUid(): number {
  const getuid = process.getuid;
  assert.ok(getuid !== undefined, "process.getuid is unavailable");
  return getuid();
}
