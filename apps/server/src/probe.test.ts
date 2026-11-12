import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { after, describe, it } from "node:test";
import type { ProbeCheck, ProbeResult } from "@foxleash/protocol";
import { parseProbeResult, probeCommand, runProbe } from "./probe.ts";
import { type ProbeReport, renderMarkdown } from "./probe-report.ts";
import { type FakeHost, startFakeHost } from "./testing/fake-host.ts";
import { SERVER_VERSION } from "./version.ts";

interface Base {
  env: NodeJS.ProcessEnv;
  socketDir: string;
  /** The working directory and report folder of a run. */
  dir: string;
}

interface Sent {
  method: string;
  params: unknown;
}

type Reply = { result: unknown } | { error: { code: string; message: string } };

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const uid = currentUid();
const root = mkdtempSync("/tmp/foxleash-test-");
const LIMIT = { timeout: 5000 };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START = new Date("2026-10-19T08:30:00.000Z");
const hosts: FakeHost[] = [];
let counter = 0;

const CHECK: ProbeCheck = {
  check: "click_button",
  target: "probe",
  element: "button type=button",
  strategy: "click_event",
  outcome: "worked",
  delivered: true,
  trustedOnly: false,
  detail: "listener ran",
};
const RESULT: ProbeResult = { userAgent: "Mozilla/5.0 Firefox/150.0", checks: [CHECK] };
const TIMEOUT_MESSAGE =
  "Foxleash is still asking the user in tab 5 whether to allow https://a.example.";

after(async () => {
  await Promise.all(hosts.map((host) => host.close()));
  rmSync(root, { recursive: true, force: true });
});

describe("runProbe", () => {
  it("opens, loads and probes each URL in order in one session", LIMIT, async () => {
    const base = privateBase();
    const host = await fakeHost(base.socketDir, standard());
    const out = path.join(base.dir, "report");
    const run = await probe(base, ["HTTPS://A.example", "http://b.example/x?y#z"], { out });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(sent(host), [
      { method: "tab_open", params: {} },
      { method: "navigate", params: { tabId: 5, url: "https://a.example/" } },
      { method: "probe_input", params: { tabId: 5 } },
      { method: "tab_open", params: {} },
      { method: "navigate", params: { tabId: 6, url: "http://b.example/x?y#z" } },
      { method: "probe_input", params: { tabId: 6 } },
    ]);
    const sessions = new Set(host.requests.map((request) => field(request, "session")));
    assert.equal(sessions.size, 1);
    assert.match(String([...sessions][0]), UUID_V4);
    assert.equal(run.stdout, `${out}.json\n${out}.md\n`);
    const report = readReport(`${out}.json`);
    assert.deepEqual(report, {
      date: START.toISOString(),
      foxleash: SERVER_VERSION,
      userAgent: RESULT.userAgent,
      pages: [
        { url: "HTTPS://A.example", checks: [CHECK] },
        { url: "http://b.example/x?y#z", checks: [CHECK] },
      ],
    });
    assert.equal(readFileSync(`${out}.md`, "utf8"), renderMarkdown(report));
    assert.ok(
      run.stderr.includes(
        "foxleash probe: opening HTTPS://A.example; Firefox may ask in the new tab whether to allow its site\n",
      ),
      run.stderr,
    );
    assert.equal(host.connections, 1);
    if (host.closes === 0) await once(host.events, "close");
    assert.equal(host.closes, 1);
  });

  it("probes a tab whose id is 0", LIMIT, async () => {
    const base = privateBase();
    const host = await fakeHost(
      base.socketDir,
      standard({ tab_open: () => ({ result: { tab: tabInfo(0) } }) }),
    );
    const run = await probe(base, ["https://a.example/"]);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(sent(host).slice(1), [
      { method: "navigate", params: { tabId: 0, url: "https://a.example/" } },
      { method: "probe_input", params: { tabId: 0 } },
    ]);
  });

  for (const code of ["approval_timeout", "settings_write_failed"]) {
    it(`asks the user and reloads after ${code}`, LIMIT, async () => {
      const base = privateBase();
      let failures = 0;
      const host = await fakeHost(
        base.socketDir,
        standard({
          navigate: () => {
            failures += 1;
            return failures === 1 ? { error: { code, message: TIMEOUT_MESSAGE } } : undefined;
          },
        }),
      );
      const run = await probe(base, ["https://a.example/"]);
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(sent(host), [
        { method: "tab_open", params: {} },
        { method: "navigate", params: { tabId: 5, url: "https://a.example/" } },
        { method: "navigate", params: { tabId: 5, action: "reload" } },
        { method: "probe_input", params: { tabId: 5 } },
      ]);
      assert.ok(
        run.stderr.includes(
          "foxleash probe: answer Foxleash's question in tab 5 in Firefox to allow https://a.example\n",
        ),
        run.stderr,
      );
      const report = readReport(onlyReport(base.dir, ".json"));
      assert.deepEqual(report.pages, [{ url: "https://a.example/", checks: [CHECK] }]);
    });
  }

  it("stops waiting after 10 minutes and skips the URLs after it", LIMIT, async () => {
    const base = privateBase();
    const host = await fakeHost(
      base.socketDir,
      standard({
        navigate: () => ({ error: { code: "approval_timeout", message: TIMEOUT_MESSAGE } }),
      }),
    );
    // Each reading of the clock is five minutes after the one before.
    let readings = 0;
    const now = (): Date => new Date(START.getTime() + 5 * 60_000 * readings++);
    const urls = ["https://a.example/", "https://b.example/", "https://c.example/"];
    const run = await probe(base, urls, { now });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(sent(host), [
      { method: "tab_open", params: {} },
      { method: "navigate", params: { tabId: 5, url: "https://a.example/" } },
      { method: "navigate", params: { tabId: 5, action: "reload" } },
    ]);
    const report = readReport(onlyReport(base.dir, ".json"));
    const notProbed = {
      code: "not_probed",
      message:
        "Foxleash's question in tab 5 is still open; answer or close it, then run the probe again.",
    };
    assert.deepEqual(report.pages, [
      { url: urls[0], error: { code: "approval_timeout", message: TIMEOUT_MESSAGE } },
      { url: urls[1], error: notProbed },
      { url: urls[2], error: notProbed },
    ]);
    assert.equal(report.userAgent, null);
    assert.equal(report.date, START.toISOString());
  });

  it("stops after 25 attempts with the clock standing still", LIMIT, async () => {
    const base = privateBase();
    const host = await fakeHost(
      base.socketDir,
      standard({
        navigate: () => ({ error: { code: "settings_write_failed", message: "Not saved." } }),
      }),
    );
    const run = await probe(base, ["https://a.example/", "https://b.example/"]);
    assert.equal(run.code, 0, run.stderr);
    const methods = sent(host).map(({ method }) => method);
    assert.deepEqual(methods, ["tab_open", ...Array.from({ length: 25 }, () => "navigate")]);
    assert.equal(run.stderr.match(/answer Foxleash's question/g)?.length, 24);
    const report = readReport(onlyReport(base.dir, ".json"));
    assert.deepEqual(
      report.pages.map((page) => ("error" in page ? page.error.code : "checks")),
      ["settings_write_failed", "not_probed"],
    );
  });

  it("records a refused or failed URL and goes on with the next one", LIMIT, async () => {
    const base = privateBase();
    const refusals = [
      { code: "site_refused", message: "The user refused https://a.example." },
      { code: "site_blocked", message: "Foxleash does not act on https://bank.example." },
    ];
    const host = await fakeHost(
      base.socketDir,
      standard({
        navigate: () => {
          const refusal = refusals.shift();
          return refusal === undefined ? undefined : { error: refusal };
        },
        probe_input: (calls) =>
          calls === 1
            ? {
                error: { code: "probe_failed", message: "Foxleash could not run its input probe." },
              }
            : { result: { ...RESULT, userAgent: `agent ${calls}` } },
      }),
    );
    const urls = ["https://a.example/", "https://bank.example/", "https://c.example/"];
    const run = await probe(base, [...urls, "https://d.example/", "https://e.example/"]);
    assert.equal(run.code, 0, run.stderr);
    const report = readReport(onlyReport(base.dir, ".json"));
    assert.deepEqual(report.pages, [
      {
        url: urls[0],
        error: { code: "site_refused", message: "The user refused https://a.example." },
      },
      {
        url: urls[1],
        error: { code: "site_blocked", message: "Foxleash does not act on https://bank.example." },
      },
      {
        url: urls[2],
        error: { code: "probe_failed", message: "Foxleash could not run its input probe." },
      },
      { url: "https://d.example/", checks: [CHECK] },
      { url: "https://e.example/", checks: [CHECK] },
    ]);
    assert.equal(report.userAgent, "agent 2");
    assert.equal(sent(host).length, 13);
  });

  it("cuts a long refusal to 200 code points", LIMIT, async () => {
    const base = privateBase();
    await fakeHost(
      base.socketDir,
      standard({
        navigate: () => ({ error: { code: "c".repeat(256), message: "\u{1f600}".repeat(300) } }),
      }),
    );
    const run = await probe(base, ["https://a.example/"]);
    assert.equal(run.code, 0, run.stderr);
    const [page] = readReport(onlyReport(base.dir, ".json")).pages;
    assert.ok(page !== undefined && "error" in page);
    assert.equal(page.error.code, "c".repeat(200));
    assert.equal(page.error.message, "\u{1f600}".repeat(200));
  });

  it("exits 1 with no report when no host runs", LIMIT, async () => {
    const base = privateBase();
    mkdirSync(base.socketDir, { mode: 0o700 });
    const run = await probe(base, ["https://a.example/"]);
    assert.equal(run.code, 1);
    assert.ok(
      run.stderr.includes("foxleash probe: No Foxleash native host is running"),
      run.stderr,
    );
    assert.equal(run.stdout, "");
    assert.deepEqual(readdirSync(base.dir), []);
  });

  for (const code of [
    "extension_disconnected",
    "protocol_mismatch",
    "session_in_use",
    "session_mismatch",
  ]) {
    it(`exits 1 with no report when the host answers ${code}`, LIMIT, async () => {
      const base = privateBase();
      const message = `The host says ${code}.`;
      const host = await fakeHost(
        base.socketDir,
        standard({
          probe_input: (calls) => (calls === 2 ? { error: { code, message } } : undefined),
        }),
      );
      const run = await probe(base, [
        "https://a.example/",
        "https://b.example/",
        "https://c.example/",
      ]);
      assert.equal(run.code, 1);
      assert.ok(run.stderr.endsWith(`foxleash probe: ${message}\n`), run.stderr);
      assert.equal(run.stdout, "");
      assert.deepEqual(readdirSync(base.dir), []);
      assert.equal(sent(host).length, 6);
    });
  }

  it("exits 1 with no report when the extension cannot read probe_input", LIMIT, async () => {
    const base = privateBase();
    const host = await fakeHost(
      base.socketDir,
      standard({
        probe_input: () => ({
          error: {
            code: "invalid_request",
            message: "Foxleash could not read the request: invalid method.",
          },
        }),
      }),
    );
    const run = await probe(base, ["https://a.example/", "https://b.example/"]);
    assert.equal(run.code, 1);
    assert.ok(
      run.stderr.endsWith(
        "foxleash probe: The Foxleash extension in Firefox is older than this command and cannot run the probe; load the current build.\n",
      ),
      run.stderr,
    );
    assert.equal(run.stdout, "");
    assert.deepEqual(readdirSync(base.dir), []);
    assert.equal(sent(host).length, 3);
  });

  it("records results it cannot read as invalid_result", LIMIT, async () => {
    const base = privateBase();
    const tabs: unknown[] = [{}, { tab: { id: -1 } }, { tab: { id: 1.5 } }, { tab: { id: "5" } }];
    const results: unknown[] = [
      null,
      { userAgent: "x" },
      { userAgent: 1, checks: [] },
      { userAgent: "x", checks: {} },
      [RESULT],
    ];
    await fakeHost(
      base.socketDir,
      standard({
        tab_open: (calls) => {
          const tab = tabs[calls - 1];
          return tab === undefined ? undefined : { result: tab };
        },
        probe_input: (calls) => ({ result: results[calls - 1] }),
      }),
    );
    const urls = Array.from({ length: tabs.length + results.length }, (_, index) => {
      return `https://${index}.example/`;
    });
    const run = await probe(base, urls);
    assert.equal(run.code, 0, run.stderr);
    const report = readReport(onlyReport(base.dir, ".json"));
    assert.deepEqual(
      report.pages.map((page) => ("error" in page ? page.error : "checks")),
      [
        ...tabs.map(() => ({
          code: "invalid_result",
          message: "The extension opened no tab with an id.",
        })),
        ...results.map(() => ({
          code: "invalid_result",
          message: "The extension's probe result is not readable.",
        })),
      ],
    );
  });

  it(
    "writes the reports under a name from the start time in the working directory",
    LIMIT,
    async () => {
      const base = privateBase();
      await fakeHost(base.socketDir, standard());
      const start = new Date(2026, 0, 2, 3, 4, 5);
      let readings = 0;
      const now = (): Date => new Date(start.getTime() + 60_000 * readings++);
      const run = await probe(base, ["https://a.example/"], { now });
      assert.equal(run.code, 0, run.stderr);
      const name = path.join(base.dir, "foxleash-probe-20260102-030405");
      assert.equal(run.stdout, `${name}.json\n${name}.md\n`);
      assert.deepEqual(readdirSync(base.dir).sort(), [
        "foxleash-probe-20260102-030405.json",
        "foxleash-probe-20260102-030405.md",
      ]);
      assert.equal(readReport(`${name}.json`).date, start.toISOString());
    },
  );

  it("resolves a relative --out against the working directory", LIMIT, async () => {
    const base = privateBase();
    await fakeHost(base.socketDir, standard());
    mkdirSync(path.join(base.dir, "sub"));
    const run = await probe(base, ["https://a.example/"], { out: "sub/mine" });
    assert.equal(run.code, 0, run.stderr);
    const name = path.join(base.dir, "sub", "mine");
    assert.equal(run.stdout, `${name}.json\n${name}.md\n`);
    assert.ok(existsSync(`${name}.md`));
  });

  it("exits 1 before opening a tab when the report's folder is missing", LIMIT, async () => {
    const base = privateBase();
    const host = await fakeHost(base.socketDir, standard());
    const out = path.join(base.dir, "missing", "report");
    writeFileSync(path.join(base.dir, "file"), "");
    for (const [name, folder] of [
      [out, path.join(base.dir, "missing")],
      [path.join(base.dir, "file", "report"), path.join(base.dir, "file")],
    ] as const) {
      const run = await probe(base, ["https://a.example/"], { out: name });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, "");
      assert.ok(
        run.stderr.endsWith(
          `foxleash probe: cannot write the report to ${name}: ${folder} is not a folder\n`,
        ),
        run.stderr,
      );
    }
    assert.deepEqual(sent(host), []);
  });

  for (const extension of [".json", ".md"]) {
    it(`exits 1 before opening a tab rather than replace a ${extension} file`, LIMIT, async () => {
      const base = privateBase();
      const host = await fakeHost(base.socketDir, standard());
      const out = path.join(base.dir, "README");
      writeFileSync(`${out}${extension}`, "keep\n");
      const run = await probe(base, ["https://a.example/"], { out });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, "");
      assert.ok(
        run.stderr.endsWith(
          `foxleash probe: cannot write the report to ${out}: ${out}${extension} already exists\n`,
        ),
        run.stderr,
      );
      assert.deepEqual(readdirSync(base.dir), [`README${extension}`]);
      assert.equal(readFileSync(`${out}${extension}`, "utf8"), "keep\n");
      assert.deepEqual(sent(host), []);
    });
  }

  it("exits 1 when it cannot write the report", LIMIT, async () => {
    const base = privateBase();
    await fakeHost(base.socketDir, standard());
    const out = path.join(base.dir, "report");
    chmodSync(base.dir, 0o500);
    try {
      const run = await probe(base, ["https://a.example/"], { out });
      assert.equal(run.code, 1);
      assert.equal(run.stdout, "");
      assert.ok(
        run.stderr.endsWith(`foxleash probe: cannot write the report to ${out} "EACCES"\n`),
        run.stderr,
      );
    } finally {
      chmodSync(base.dir, 0o700);
    }
  });
});

describe("probeCommand", () => {
  it("refuses to run without process.getuid", LIMIT, async () => {
    const stderr = collector();
    const stdout = collector();
    const code = await probeCommand(
      {
        urls: ["https://a.example/"],
        out: undefined,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
      { env: {}, cwd: () => root },
    );
    assert.equal(code, 1);
    assert.equal(stderr.text(), "foxleash probe runs on Linux only.\n");
    assert.equal(stdout.text(), "");
  });

  it("runs the probe with the process's environment and working directory", LIMIT, async () => {
    const base = privateBase();
    await fakeHost(base.socketDir, standard());
    const stderr = collector();
    const stdout = collector();
    const code = await probeCommand(
      { urls: ["https://a.example/"], out: "named", stdout: stdout.stream, stderr: stderr.stream },
      { env: base.env, cwd: () => base.dir, getuid: () => uid },
    );
    assert.equal(code, 0, stderr.text());
    const name = path.join(base.dir, "named");
    assert.equal(stdout.text(), `${name}.json\n${name}.md\n`);
    const report = readReport(`${name}.json`);
    assert.ok(Math.abs(Date.parse(report.date) - Date.now()) < 60_000, report.date);
  });
});

describe("parseProbeResult", () => {
  it("keeps a valid result, building fresh objects with only the known keys", () => {
    const value = {
      userAgent: "agent",
      extra: "dropped",
      checks: [
        { ...CHECK, extra: "dropped" },
        { ...CHECK, element: undefined },
      ],
    };
    const { element: _element, ...withoutElement } = CHECK;
    assert.deepEqual(parseProbeResult(value), {
      userAgent: "agent",
      checks: [CHECK, withoutElement],
    });
    const parsed = parseProbeResult(value);
    assert.equal(Object.hasOwn(parsed?.checks[1] ?? {}, "element"), false);
  });

  for (const value of [
    null,
    "x",
    [],
    { checks: [] },
    { userAgent: "x" },
    { userAgent: "x", checks: "" },
  ]) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      assert.equal(parseProbeResult(value), undefined);
    });
  }

  const malformed: Record<string, unknown>[] = [
    { check: "submit_form" },
    { check: undefined },
    { check: "toString" },
    { target: "page" },
    { target: "constructor" },
    { outcome: "maybe" },
    { outcome: "__proto__" },
    { strategy: 1 },
    { detail: null },
    { delivered: "true" },
    { trustedOnly: 0 },
    { element: 5 },
    { element: "(https://x.example/" },
    { element: `${"a".repeat(41)}` },
    { element: "div .a .b .c .d" },
    { element: "Div" },
    { element: "div role=Textbox" },
    { element: "div role=textbox type=text" },
    { element: "div  .a" },
    { element: "div .a " },
    { element: "div\n.a" },
    { element: "" },
    { element: "div .a(b" },
  ];
  it("drops each malformed check and keeps the rest", () => {
    for (const fields of malformed) {
      const label = JSON.stringify(fields);
      const parsed = parseProbeResult({ userAgent: "x", checks: [{ ...CHECK, ...fields }, CHECK] });
      assert.deepEqual(parsed?.checks, [CHECK], label);
    }
    assert.deepEqual(parseProbeResult({ userAgent: "x", checks: [null, [], "x", CHECK] })?.checks, [
      CHECK,
    ]);
  });

  for (const element of [
    "div role=textbox editor=gmail .a .b_c .d-e",
    "input type=datetime-local",
    "body editor=google_docs",
    "custom",
    `${"a".repeat(40)} .${"B".repeat(40)}`,
  ]) {
    it(`keeps the descriptor ${element}`, () => {
      assert.deepEqual(
        parseProbeResult({ userAgent: "x", checks: [{ ...CHECK, element }] })?.checks,
        [{ ...CHECK, element }],
      );
    });
  }

  it("keeps every outcome, target and check name", () => {
    const checks = [
      ...["worked", "no_effect", "no_target", "unknown", "error"].map((outcome) => ({
        ...CHECK,
        outcome,
      })),
      { ...CHECK, target: "site" },
      ...[
        "click_link",
        "type_input",
        "type_contenteditable",
        "type_rich_editor",
        "enter_in_form",
        "tab_focus",
      ].map((check) => ({ ...CHECK, check })),
    ];
    assert.deepEqual(parseProbeResult({ userAgent: "x", checks })?.checks, checks);
  });

  it("keeps at most 50 checks", () => {
    const checks = Array.from({ length: 60 }, (_, index) => ({ ...CHECK, detail: `d${index}` }));
    const parsed = parseProbeResult({ userAgent: "x", checks });
    assert.equal(parsed?.checks.length, 50);
    assert.equal(parsed?.checks.at(-1)?.detail, "d49");
  });

  it("cuts every string to 200 code points without splitting a pair", () => {
    const long = `${"x".repeat(199)}${"\u{1f600}".repeat(300)}`;
    const classes = Array.from({ length: 3 }, () => `.${"c".repeat(40)}`).join(" ");
    const parsed = parseProbeResult({
      userAgent: long,
      checks: [{ ...CHECK, strategy: long, detail: long }],
    });
    const cut = `${"x".repeat(199)}\u{1f600}`;
    assert.equal(parsed?.userAgent, cut);
    assert.equal(parsed?.checks[0]?.strategy, cut);
    assert.equal(parsed?.checks[0]?.detail, cut);
    assert.ok(parsed?.userAgent.isWellFormed());
    const longElement = `${"a".repeat(40)} type=${"b".repeat(20)} role=${"r".repeat(20)} editor=${"e".repeat(20)} ${classes}`;
    const kept = parseProbeResult({ userAgent: "x", checks: [{ ...CHECK, element: longElement }] });
    assert.equal(kept?.checks[0]?.element, Array.from(longElement).slice(0, 200).join(""));
  });
});

function standard(
  overrides: Partial<Record<string, (calls: number) => Reply | undefined>> = {},
): (request: unknown) => unknown {
  const calls = new Map<string, number>();
  let nextTab = 5;
  return (request) => {
    const method = String(field(request, "method"));
    const count = (calls.get(method) ?? 0) + 1;
    calls.set(method, count);
    const reply = overrides[method]?.(count) ?? defaultReply(method);
    return { type: "response", id: field(request, "id"), ...replyFields(reply) };
  };

  function defaultReply(method: string): Reply {
    if (method === "tab_open") return { result: { tab: tabInfo(nextTab++) } };
    if (method === "navigate") return { result: { tab: tabInfo(nextTab - 1) } };
    return { result: RESULT };
  }
}

function replyFields(reply: Reply): Record<string, unknown> {
  return "error" in reply ? { ok: false, error: reply.error } : { ok: true, result: reply.result };
}

function tabInfo(id: number): Record<string, unknown> {
  return { id, url: "https://a.example/", title: "A", active: true };
}

async function probe(
  base: Base,
  urls: string[],
  options: { out?: string; now?: () => Date } = {},
): Promise<Run> {
  const stdout = collector();
  const stderr = collector();
  const code = await runProbe({
    urls,
    out: options.out,
    env: base.env,
    uid,
    cwd: base.dir,
    now: options.now ?? (() => START),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function sent(host: FakeHost): Sent[] {
  return host.requests.map((request) => ({
    method: String(field(request, "method")),
    params: field(request, "params"),
  }));
}

function readReport(file: string): ProbeReport {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(typeof value === "object" && value !== null && "pages" in value);
  // The shape is what the assertions on it check.
  return value as ProbeReport;
}

function onlyReport(dir: string, extension: string): string {
  const names = readdirSync(dir).filter((name) => name.endsWith(extension));
  assert.equal(names.length, 1, names.join(", "));
  return path.join(dir, names[0] ?? "");
}

function privateBase(): Base {
  counter += 1;
  const base = path.join(root, `base-${counter}`);
  mkdirSync(base, { mode: 0o700 });
  chmodSync(base, 0o700);
  const dir = path.join(root, `work-${counter}`);
  mkdirSync(dir);
  return { env: { XDG_RUNTIME_DIR: base }, socketDir: path.join(base, "foxleash"), dir };
}

async function fakeHost(
  socketDir: string,
  respond: (request: unknown) => unknown,
): Promise<FakeHost> {
  mkdirSync(socketDir, { mode: 0o700 });
  const host = await startFakeHost({ dir: socketDir, pid: 1000 + counter, respond });
  hosts.push(host);
  return host;
}

function collector(): { stream: Writable; text(): string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk: unknown, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
    text: () => chunks.join(""),
  };
}

function field(value: unknown, key: string): unknown {
  assert.ok(typeof value === "object" && value !== null);
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function currentUid(): number {
  const getuid = process.getuid;
  assert.ok(getuid !== undefined, "process.getuid is unavailable");
  return getuid();
}
