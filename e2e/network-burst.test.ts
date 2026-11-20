import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MAX_NETWORK_BODY_FIELDS, type NetworkRequestRead, type TabInfo } from "@foxleash/protocol";
import { type Firefox, isRecord, PAGE_TIMEOUT_MS, pollUntil } from "./firefox.ts";
import { type FixtureServer, startFixtureServer, TITLES } from "./fixture-server.ts";
import {
  createHarness,
  EXTENSION_DIST,
  type Harness,
  parseResult,
  type Session,
  tabOf,
  tabsOf,
} from "./harness.ts";

const SINK = "/api/burst-sink";
const SMALL_BODIES = 20;
/** How many large bodies each burst sends. */
const BURST = 20;
/** Under Firefox's limit for request bodies, so the form's body reaches the extension whole. */
const FORM_BYTES = 16_700_000;
/** Apart enough for Firefox's own handling of each body on a slow machine. */
const FORM_EVERY_MS = 250;
const JSON_BYTES = 6_000_000;
const FETCH_EVERY_MS = 100;
/** How long a tool call may take while a tab outside the session sends its burst. */
const OUTSIDE_LIMIT_MS = 2_000;
/** The same in the tab that sends it, where a body being read can hold the call up. */
const INSIDE_LIMIT_MS = 3_000;
/** How long the calls go on after the form burst's last submit. */
const AFTER_FORMS_MS = 2_000;
/** A call that takes longer than this fails by its own timeout, well over both limits. */
const CALL_TIMEOUT_MS = 30_000;
/**
 * How long a burst and the calls during it may take in all. No call starts after it, and none
 * waits longer than its limit past it, so the rest of a test's 60 s is left for what comes before
 * and after.
 */
const BURST_DEADLINE_MS = 30_000;
const PAUSE_MS = 100;
const MEMORY_SAMPLE_MS = 500;
/**
 * Counts memory that processes share once for each, so it reads high: it is there to stop a
 * runaway, not to measure.
 */
const MEMORY_LIMIT_MIB = 6_144;
const MEMORY_GUARD_FIRED = `the memory guard killed Firefox: its processes passed ${MEMORY_LIMIT_MIB} MiB`;
/**
 * The hidden inputs of the many-names form, `k<n>=v`: about 1,000,000 bytes urlencoded, so Firefox
 * parses the body into one field per name.
 */
const NAMES = 111_112;
/** Firefox parses the fields of a urlencoded body only under this many bytes. */
const FORM_PARSE_BYTES = 1_048_576;
/** How many times a tab outside the session submits the many-names form. */
const NAMES_BURST = 50;
const NAMES_EVERY_MS = 50;
/**
 * How long the page may take to submit the many-names form NAMES_BURST times, which takes longer
 * than one submit every NAMES_EVERY_MS; with SETTLE_MS it keeps the test inside its 60 s.
 */
const NAMES_BURST_WAIT_MS = 35_000;
/** How long the sampling goes on after the last submit: a backlog can keep a process growing. */
const SETTLE_MS = 10_000;
const PROCESS_SAMPLE_MS = 250;
/** How much the extension process may grow while a tab outside the session sends the burst. */
const OUTSIDE_GROWTH_LIMIT_MIB = 150;

/** One sample of a process's memory: when, in ms since the sampling began, and how much. */
interface ProcessSample {
  at: number;
  mib: number;
}

interface MemoryGuard {
  /** The most the processes held at a sample since the last `resetPeak`, in MiB. */
  peakMib(): number;
  resetPeak(): void;
  /** Whether the processes passed the limit, and Firefox was killed. */
  fired(): boolean;
  stop(): void;
}

// One Firefox for the file, as in network.test.ts. The small burst comes first, so that nothing
// of a large one is left to wait out.
describe("read_network during a burst of request bodies in real Firefox", () => {
  let harness: Harness;
  let fixtures: FixtureServer;
  let firefox: Firefox;
  let session: Session;
  let memory: MemoryGuard | undefined;

  before(
    async () => {
      harness = createHarness();
      harness.install();
      fixtures = await startFixtureServer();
      firefox = await harness.startFirefox(EXTENSION_DIST);
      memory = startMemoryGuard(firefox.pid);
      await harness.seedSettings({
        [`site:${fixtures.site}`]: { grantedAt: new Date().toISOString() },
      });
      session = await harness.connect();
      await harness.waitUntilReady(session);
    },
    { timeout: 120_000 },
  );

  after(
    async () => {
      // First: once Firefox is gone, its process id can come to name another process.
      memory?.stop();
      try {
        await harness?.close();
      } finally {
        await fixtures?.close();
      }
    },
    { timeout: 60_000 },
  );

  test("many small bodies sent at once all keep their shapes", async () => {
    const { tab, context } = await openBurstPage("small");
    assert.equal(await firefox.evaluate(context, `smallBurst(${SMALL_BODIES})`), SMALL_BODIES);
    const requests = await readSink(tab, SMALL_BODIES);
    for (const { url, requestBody } of requests) {
      assert.equal(requestBody?.kind, "json", `${url}: ${JSON.stringify(requestBody)}`);
      assert.deepEqual(
        requestBody.fields?.map(({ name }) => name),
        ["index", "name", "ok"],
        url,
      );
    }
  });

  test("large form posts from a tab outside the session leave tool calls quick", async (t) => {
    const guard = guardOf(memory);
    guard.resetPeak();
    try {
      // A tab of the session. Its small bodies tell whether a body of the other tab was read: the
      // time that took would leave them unread.
      const inside = await openBurstPage("inside");
      const own = idsOf(tabsOf(await harness.ok(session, "tabs_list")));
      const url = fixtures.url("/network-burst?outside");
      // A tab the session does not have, opened as the user would.
      const context = await firefox.openContext(url);
      const bytes = await firefox.evaluate(context, `buildForm(${FORM_BYTES})`);
      assert.ok(typeof bytes === "number" && bytes >= FORM_BYTES, String(bytes));
      assert.equal(await firefox.evaluate(context, `formBurst(${BURST}, ${FORM_EVERY_MS})`), true);
      let small = 0;
      const listings = await listTabsDuring(
        t,
        context,
        AFTER_FORMS_MS,
        OUTSIDE_LIMIT_MS,
        async () => {
          assert.equal(await firefox.evaluate(inside.context, "smallBurst(1)"), 1);
          small += 1;
        },
      );
      for (const listed of listings) {
        assert.deepEqual(idsOf(listed), own, JSON.stringify(listed));
        assert.equal(
          listed.some((tab) => tab.url === url),
          false,
          JSON.stringify(listed),
        );
      }
      for (const { requestBody } of await readSink(inside.tab, small)) {
        assert.equal(requestBody?.kind, "json", JSON.stringify(requestBody));
      }
      t.diagnostic(`bodies the session's tab sent meanwhile, all with their shapes: ${small}`);
    } finally {
      t.diagnostic(`peak memory of Firefox's processes: ${guard.peakMib()} MiB`);
      // After the kill a tool call fails first, with its own message: this one says why.
      assert.equal(guard.fired(), false, MEMORY_GUARD_FIRED);
    }
  });

  test("large fetch bodies in a session's tab leave tool calls answering, some bodies unread", async (t) => {
    const guard = guardOf(memory);
    guard.resetPeak();
    try {
      const pid = await firefox.extensionProcessId();
      const { tab, context } = await openBurstPage("fetch");
      // Firefox slows the timers of a hidden tab down, to a body a second: each would be read.
      await untilShown(context);
      const bytes = await firefox.evaluate(context, `buildJson(${JSON_BYTES})`);
      assert.ok(typeof bytes === "number" && bytes >= JSON_BYTES, String(bytes));
      // The shaping of these bodies holds the background up: the most a backlog can build up.
      const watch = watchProcess(pid);
      try {
        assert.equal(
          await firefox.evaluate(context, `fetchBurst(${BURST}, ${FETCH_EVERY_MS})`),
          true,
        );
        await listTabsDuring(t, context, 0, INSIDE_LIMIT_MS);
      } finally {
        reportGrowth(t, watch.stop());
      }
      const bodies = (await readSink(tab, BURST)).map(({ requestBody }) => requestBody);
      const shaped = bodies.filter((body) => body?.kind === "json");
      const unread = bodies.filter((body) => body?.kind !== "json");
      for (const body of shaped) {
        assert.equal(body?.fields?.length, MAX_NETWORK_BODY_FIELDS, JSON.stringify(body));
        assert.equal(body?.truncated, true, JSON.stringify(body));
      }
      for (const body of unread) assert.deepEqual(body, { kind: "other" });
      t.diagnostic(`bodies shaped: ${shaped.length}, left unread: ${unread.length}`);
      assert.ok(shaped.length >= 1, "no body kept its shape");
      assert.ok(unread.length >= 1, "every body was read, however long the reading took");
    } finally {
      t.diagnostic(`peak memory of Firefox's processes: ${guard.peakMib()} MiB`);
      assert.equal(guard.fired(), false, MEMORY_GUARD_FIRED);
    }
  });

  test("a burst of many-name form posts from a tab outside the session leaves the extension's process its memory", async (t) => {
    const guard = guardOf(memory);
    guard.resetPeak();
    try {
      const pid = await firefox.extensionProcessId();
      // A tab of the session, so that the session runs with a body listener of its own while the
      // burst is sent, whatever ran before.
      await openBurstPage("names-inside");
      // A tab the session does not have, opened as the user would.
      const context = await firefox.openContext(fixtures.url("/network-burst?names-outside"));
      await untilShown(context);
      checkNamesForm(t, await firefox.evaluate(context, `buildNamesForm(${NAMES})`));
      const growth = await namesBurst(t, pid, context);
      assert.ok(
        growth < OUTSIDE_GROWTH_LIMIT_MIB,
        `the extension's process grew by ${growth} MiB, over ${OUTSIDE_GROWTH_LIMIT_MIB} MiB`,
      );
    } finally {
      t.diagnostic(`peak memory of Firefox's processes: ${guard.peakMib()} MiB`);
      assert.equal(guard.fired(), false, MEMORY_GUARD_FIRED);
    }
  });

  /** Waits until the page's tab is the one its window shows: Firefox slows a hidden tab's timers. */
  async function untilShown(context: string): Promise<void> {
    await pollUntil(
      async () => {
        const state = await firefox.evaluate(context, "document.visibilityState");
        return state === "visible" ? true : undefined;
      },
      PAGE_TIMEOUT_MS,
      "the burst page to be the tab its window shows",
    );
  }

  /**
   * Submits the page's many-names form NAMES_BURST times, sampling the process from before the
   * first submit until SETTLE_MS after the last; gives how much it grew from its first sample to
   * its peak, in MiB.
   */
  async function namesBurst(
    t: { diagnostic(message: string): void },
    pid: number,
    context: string,
  ): Promise<number> {
    const watch = watchProcess(pid);
    let growth = Number.NaN;
    try {
      assert.equal(
        await firefox.evaluate(context, `formBurst(${NAMES_BURST}, ${NAMES_EVERY_MS})`),
        true,
      );
      await pollUntil(
        async () =>
          (await firefox.evaluate(context, "window.burstDone")) === true ? true : undefined,
        NAMES_BURST_WAIT_MS,
        "the form burst to end",
      );
      await sleep(SETTLE_MS);
    } finally {
      // Also when the burst failed: the figures say why.
      growth = reportGrowth(t, watch.stop());
    }
    return growth;
  }

  /** Opens the burst page in a new tab of the session; its tab id and its page's context. */
  async function openBurstPage(tag: string): Promise<{ tab: number; context: string }> {
    const url = fixtures.url(`/network-burst?${tag}`);
    const tab = tabOf(await harness.ok(session, "tab_open", { url })).id;
    await pollUntil(
      async () => {
        const listed = tabsOf(await harness.ok(session, "tabs_list")).find(({ id }) => id === tab);
        return listed?.title === TITLES.networkBurst ? true : undefined;
      },
      PAGE_TIMEOUT_MS,
      `tab ${tab} to show ${TITLES.networkBurst}`,
    );
    const page = (await firefox.contexts()).find((context) => context.url === url);
    assert.ok(page !== undefined, `no tab shows ${url}`);
    return { tab, context: page.context };
  }

  /** Reads the tab's requests to the sink until `count` of them have answered; gives those. */
  function readSink(tab: number, count: number): Promise<NetworkRequestRead[]> {
    return pollUntil(
      async () => {
        const result = await harness.call(session, "read_network", {
          tabId: tab,
          body: true,
          pattern: SINK,
          limit: 2 * count,
        });
        assert.equal(result.isError, false, result.text);
        const requests = requestsOf(parseResult(result.text));
        assert.equal(requests.length, count, result.text);
        assert.ok(
          requests.every((request) => request.status !== undefined),
          result.text,
        );
        return requests;
      },
      PAGE_TIMEOUT_MS,
      `${count} answered requests to ${SINK} in tab ${tab}`,
    );
  }

  /**
   * Calls tabs_list, one call after the other, until the burst of the page in `context` is done
   * and `afterMs` more have passed. Each call must answer within `limitMs`. Gives what each call
   * listed, and reports the slowest call. `between` runs after each call.
   */
  async function listTabsDuring(
    t: { diagnostic(message: string): void },
    context: string,
    afterMs: number,
    limitMs: number,
    between?: () => Promise<void>,
  ): Promise<TabInfo[][]> {
    const listings: TabInfo[][] = [];
    const started = performance.now();
    let slowest = 0;
    let doneAt: number | undefined;
    try {
      for (;;) {
        const called = performance.now();
        const left = BURST_DEADLINE_MS - (called - started);
        assert.ok(left > 0, `the burst did not end within ${BURST_DEADLINE_MS} ms`);
        const timeout = Math.ceil(Math.min(CALL_TIMEOUT_MS, left + limitMs));
        const result = await harness.call(session, "tabs_list", {}, timeout);
        const took = performance.now() - called;
        slowest = Math.max(slowest, took);
        assert.equal(result.isError, false, result.text);
        assert.ok(took <= limitMs, `tabs_list took ${Math.round(took)} ms, over ${limitMs} ms`);
        listings.push(tabsOf(parseResult(result.text)));
        await between?.();
        if (
          doneAt === undefined &&
          (await firefox.evaluate(context, "window.burstDone")) === true
        ) {
          doneAt = performance.now();
        }
        if (doneAt !== undefined && performance.now() - doneAt >= afterMs) return listings;
        await sleep(PAUSE_MS);
      }
    } finally {
      t.diagnostic(`slowest of ${listings.length} tabs_list calls: ${Math.round(slowest)} ms`);
    }
  }
});

/** Checks the many-names form's body length: at least 1,000,000 bytes, under Firefox's edge. */
function checkNamesForm(t: { diagnostic(message: string): void }, bytes: unknown): void {
  assert.ok(
    typeof bytes === "number" && bytes >= 1_000_000 && bytes < FORM_PARSE_BYTES,
    String(bytes),
  );
  t.diagnostic(`many-names form: ${bytes} bytes urlencoded`);
}

/**
 * Reports the samples of a process, its first, its peak, the growth between them and one sample
 * a second; gives the growth in MiB.
 */
function reportGrowth(t: { diagnostic(message: string): void }, samples: ProcessSample[]): number {
  const first = samples[0];
  assert.ok(first !== undefined, "the extension's process was gone before its first sample");
  const peak = Math.max(...samples.map(({ mib }) => mib));
  const growth = peak - first.mib;
  const series: string[] = [];
  let shown = -1;
  for (const { at, mib } of samples) {
    const second = Math.floor(at / 1000);
    if (second <= shown) continue;
    series.push(`${second}s ${mib}`);
    shown = second;
  }
  t.diagnostic(
    `extension's process: first ${first.mib} MiB, peak ${peak} MiB, growth ${growth} MiB`,
  );
  t.diagnostic(`extension's process by second: ${series.join(" | ")}`);
  return growth;
}

/**
 * Samples one process's memory, resident and swapped out, every PROCESS_SAMPLE_MS from now on,
 * the first at once; stops by itself once the process is gone. `stop` gives the samples.
 */
function watchProcess(pid: number): { stop(): ProcessSample[] } {
  const started = performance.now();
  const samples: ProcessSample[] = [];
  const timer = setInterval(sample, PROCESS_SAMPLE_MS);
  sample();
  return {
    stop: () => {
      clearInterval(timer);
      return samples;
    },
  };

  function sample(): void {
    const status = statusOf(String(pid));
    if (status === undefined) {
      clearInterval(timer);
      return;
    }
    samples.push({ at: performance.now() - started, mib: Math.round(status.kb / 1024) });
  }
}

function guardOf(memory: MemoryGuard | undefined): MemoryGuard {
  assert.ok(memory !== undefined, "the memory guard did not start");
  return memory;
}

function idsOf(tabs: readonly TabInfo[]): number[] {
  return tabs.map(({ id }) => id);
}

function requestsOf(value: unknown): NetworkRequestRead[] {
  assert.ok(isRecord(value) && Array.isArray(value.requests), JSON.stringify(value));
  const requests: NetworkRequestRead[] = value.requests;
  return requests;
}

/**
 * Samples the memory of Firefox's process and all its descendants, resident and swapped out, and
 * kills Firefox's process group when they pass MEMORY_LIMIT_MIB together, so a burst that is not
 * bounded as it should be cannot take the machine down.
 */
function startMemoryGuard(pid: number): MemoryGuard {
  let peak = 0;
  let fired = false;
  const timer = setInterval(sample, MEMORY_SAMPLE_MS);
  return {
    peakMib: () => Math.round(peak),
    resetPeak: () => {
      peak = 0;
    },
    fired: () => fired,
    stop: () => clearInterval(timer),
  };

  function sample(): void {
    const mib = treeMemoryMib(pid);
    // Gone: from now on its id can name another process, which is never sampled or killed.
    if (mib === undefined) {
      clearInterval(timer);
      return;
    }
    peak = Math.max(peak, mib);
    if (mib <= MEMORY_LIMIT_MIB) return;
    fired = true;
    clearInterval(timer);
    try {
      // Firefox leads its own process group (see killGroupSync in firefox.ts).
      process.kill(-pid, "SIGKILL");
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

/**
 * The memory of the process and its descendants in MiB, resident and swapped out; undefined once
 * it is gone.
 */
function treeMemoryMib(root: number): number | undefined {
  const processes = new Map<number, ProcessStatus>();
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    const status = statusOf(name);
    if (status !== undefined) processes.set(Number(name), status);
  }
  if (!processes.has(root)) return undefined;
  const children = new Map<number, number[]>();
  for (const [pid, { parent }] of processes) {
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  let kb = 0;
  const seen = new Set<number>();
  const left = [root];
  for (let pid = left.pop(); pid !== undefined; pid = left.pop()) {
    // An id that came to name a new process during the reading could close a circle.
    if (seen.has(pid)) continue;
    seen.add(pid);
    kb += processes.get(pid)?.kb ?? 0;
    left.push(...(children.get(pid) ?? []));
  }
  return kb / 1024;
}

interface ProcessStatus {
  parent: number;
  /** Resident and swapped out: under memory pressure a runaway grows in swap. */
  kb: number;
}

/** From /proc/<pid>/status; undefined for a process that ended while it was read. */
function statusOf(pid: string): ProcessStatus | undefined {
  let status: string;
  try {
    status = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return undefined;
  }
  const parent = /^PPid:\s+([0-9]+)$/m.exec(status)?.[1];
  if (parent === undefined) return undefined;
  // A kernel thread has neither line.
  const rss = /^VmRSS:\s+([0-9]+) kB$/m.exec(status)?.[1];
  const swap = /^VmSwap:\s+([0-9]+) kB$/m.exec(status)?.[1];
  return { parent: Number(parent), kb: Number(rss ?? 0) + Number(swap ?? 0) };
}
