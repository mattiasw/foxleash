import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { InjectionResult } from "./browser-api.ts";
import { RECORDER_OPTIONS } from "./console-messages.ts";
import { recordConsole } from "./console-recorder.ts";
import {
  createConsoleRecording,
  RECORDER_ATTEMPTS,
  RECORDER_RETRY_MS,
} from "./console-recording.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  type FakeTab,
  type FakeTimers,
  flush,
} from "./fake-browser.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite } from "./settings.ts";
import { createSiteAccess, PROMPT_PAGE, type SessionMemory } from "./site-access.ts";

const SITE = "https://a.example";
const URL_A = `${SITE}/page`;
/** What the recording's clock reads before the fake timers advance. */
const START = 1_000_000;
const OTHER = "https://b.example";
const URL_B = `${OTHER}/page`;

describe("console recording", { timeout: 10000 }, () => {
  it("starts the recorder in the top frame of a committed page on an approved site", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, clock, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.deepEqual(fake.injections, [
      {
        tabId: tab.id,
        func: recordConsole,
        args: [SITE, RECORDER_OPTIONS, false],
        world: "MAIN",
        injectImmediately: true,
        frameIds: [0],
      },
    ]);
    const live = recordings.liveRecording("s1", tab.id);
    assert.ok(live !== undefined);
    assert.equal(recordings.liveRecording("s1", tab.id), live);
    assert.equal(recordings.liveRecording("s2", tab.id), undefined);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(warned(), []);
  });

  it("starts it for a site the session approved, and for a stored one", async () => {
    const { fake, recordings, tabIn, sessions } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1");
    fake.navigateByUser(tab.id, "https://b.example/");
    await flush();
    assert.equal(fake.injections.length, 1);
    assert.deepEqual(fake.injections[0]?.args, ["https://b.example", RECORDER_OPTIONS, false]);
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
  });

  it("gates the committed URL, not the tab's", async () => {
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1", "https://b.example/");
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A });
    await flush();
    assert.deepEqual(fake.injections[0]?.args, [SITE, RECORDER_OPTIONS, false]);
    const other = await tabIn("s1", URL_A);
    fake.injections.length = 0;
    fake.emitCommitted({ tabId: other.id, frameId: 0, url: "https://b.example/" });
    await flush();
    assert.deepEqual(fake.injections, []);
    assert.equal(recordings.liveRecording("s1", other.id), undefined);
  });

  it("records nothing in a frame, outside a session's group, or off an approved site", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn, groups, access } = setup();
    await fake.browser.storage.local.set({ blocklist: ["blocked.example"] });
    await grantSite(fake.browser, "https://blocked.example");
    const grouped = await tabIn("s1");
    const loose = fake.openTab({ url: URL_A });
    const userGroup = fake.openTab({ url: URL_A });
    await fake.browser.tabs.group({ tabIds: [userGroup.id] });
    assert.equal(groups.sessionOf(fake.tabs.get(userGroup.id)?.groupId), undefined);
    fake.injections.length = 0;
    const commits = [
      { tabId: grouped.id, frameId: 1, url: URL_A },
      { tabId: loose.id, frameId: 0, url: URL_A },
      { tabId: userGroup.id, frameId: 0, url: URL_A },
      { tabId: grouped.id, frameId: 0, url: "https://c.example/" },
      { tabId: grouped.id, frameId: 0, url: "https://blocked.example/" },
      { tabId: grouped.id, frameId: 0, url: "about:blank" },
      { tabId: grouped.id, frameId: 0, url: fake.browser.runtime.getURL(PROMPT_PAGE) },
      { tabId: 999, frameId: 0, url: URL_A },
    ];
    for (const details of commits) {
      fake.emitCommitted(details);
      await flush();
      assert.deepEqual(fake.injections, [], JSON.stringify(details));
      for (const tabId of [grouped.id, loose.id, userGroup.id]) {
        assert.equal(recordings.liveRecording("s1", tabId), undefined, JSON.stringify(details));
      }
    }
    // Only the tab that does not exist is worth a log line; the rest are refusals.
    assert.deepEqual(
      warned().map((fields) => [fields.event, fields.tabId]),
      [["console_recording_failed", 999]],
    );
    assert.equal(access.openPrompt("s1"), undefined);
  });

  it("records nothing in the session's open prompt tab", async () => {
    const { fake, recordings, tabIn, access } = setup();
    const tab = await tabIn("s1");
    await access.ask("s1", "https://c.example/", tab.id, { generation: access.generation("s1") });
    assert.equal(access.openPrompt("s1")?.tabId, tab.id);
    fake.injections.length = 0;
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A });
    await flush();
    assert.deepEqual(fake.injections, []);
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
  });

  const MISSES: {
    name: string;
    first: InjectionResult<unknown>[] | Error;
    logged: Record<string, unknown>;
    current: boolean;
  }[] = [
    {
      name: "running in the previous page",
      first: [{ frameId: 0, result: "present", documentId: "doc-old" }],
      logged: { status: "present", sameDocument: false },
      current: true,
    },
    {
      name: "running in the new tab's blank page",
      first: [{ frameId: 0, result: "elsewhere", documentId: "doc-old" }],
      logged: { status: "elsewhere", sameDocument: false },
      current: false,
    },
    {
      name: "running in another document, unnamed",
      first: [{ frameId: 0, result: "elsewhere" }],
      logged: { status: "elsewhere" },
      current: true,
    },
    {
      name: "no top frame",
      first: [{ frameId: 3, result: "started", documentId: "doc-new" }],
      logged: { status: "missing" },
      current: false,
    },
    {
      name: "an error in the top frame",
      first: [{ frameId: 0, error: new Error("from the page"), documentId: "doc-new" }],
      logged: { status: "error", sameDocument: true },
      current: true,
    },
    {
      name: "a rejected injection",
      first: new Error("Injection refused"),
      logged: { status: "rejected", error: "Error: Injection refused" },
      current: false,
    },
  ];
  for (const { name, first, logged, current } of MISSES) {
    it(`injects the recorder again after ${name}, until it starts`, async (t) => {
      const warned = quiet(t);
      const { fake, recordings, clock, tabIn } = setup();
      const tab = await tabIn("s1");
      if (current) fake.setFrames(tab.id, [{ frameId: 0, documentId: "doc-new" }]);
      if (first instanceof Error) fake.failNextInjection(first);
      else fake.nextInjectionResults = [first];
      fake.injectionResults = [{ frameId: 0, result: "started", documentId: "doc-new" }];
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-new" });
      await flush();
      assert.equal(fake.injections.length, 1);
      // Not exposed until the recorder landed.
      assert.equal(recordings.liveRecording("s1", tab.id), undefined);
      clock.advance(RECORDER_RETRY_MS - 1);
      await flush();
      assert.equal(fake.injections.length, 1);
      clock.advance(1);
      await flush();
      assert.equal(fake.injections.length, 2);
      assert.deepEqual(fake.injections[1], fake.injections[0]);
      assert.deepEqual(recordings.liveRecording("s1", tab.id), {
        since: START + RECORDER_RETRY_MS,
      });
      assert.equal(clock.pending(), 0);
      assert.deepEqual(warned(), [
        { event: "console_recording_retry", tabId: tab.id, ...logged, currentDocument: current },
        {
          event: "console_recording_started",
          tabId: tab.id,
          attempts: 2,
          status: "started",
          sameDocument: true,
          currentDocument: current,
        },
      ]);
    });
  }

  it("keeps a recorder that started in a document other than the one the commit named", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, clock, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.injectionResults = [{ frameId: 0, result: "started", documentId: "doc-old" }];
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-new" });
    await flush();
    assert.equal(fake.injections.length, 1);
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(warned(), [
      {
        event: "console_recording_started",
        tabId: tab.id,
        attempts: 1,
        status: "started",
        sameDocument: false,
        currentDocument: false,
      },
    ]);
  });

  it("logs no currentDocument when the tab's frames cannot be read", async (t) => {
    const warned = quiet(t);
    const { fake, clock, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.injectionResults = [{ frameId: 0, result: "started", documentId: "doc-old" }];
    fake.setFrames(tab.id, null);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-new" });
    await flush();
    fake.setFrames(tab.id, [{ frameId: 0 }]);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-new" });
    await flush();
    t.mock.method(fake.browser.webNavigation, "getAllFrames", async () => {
      throw new Error("No tab with id");
    });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-new" });
    await flush();
    assert.equal(clock.pending(), 0);
    const started = {
      event: "console_recording_started",
      tabId: tab.id,
      attempts: 1,
      status: "started",
      sameDocument: false,
    };
    assert.deepEqual(warned(), [started, started, started]);
  });

  it("keeps a recorder already present in the committed document, and only there", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, clock, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.setFrames(tab.id, [{ frameId: 0, documentId: "doc-new" }]);
    fake.injectionResults = [{ frameId: 0, result: "present", documentId: "doc-new" }];
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-new" });
    await flush();
    assert.equal(fake.injections.length, 1);
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(warned(), [
      {
        event: "console_recording_started",
        tabId: tab.id,
        attempts: 1,
        status: "present",
        sameDocument: true,
        currentDocument: true,
      },
    ]);
    // Without the ids, a recorder already there may be the previous page's.
    fake.injectionResults = [{ frameId: 0, result: "present" }];
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.equal(fake.injections.length, 2);
    assert.equal(clock.pending(), 1);
    assert.deepEqual(warned().slice(1), [
      { event: "console_recording_retry", tabId: tab.id, status: "present" },
    ]);
  });

  it("gives up once the recorder has not started in the committed document in time", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, clock, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.injectionResults = [{ frameId: 0, result: "elsewhere", documentId: "doc-old" }];
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-new" });
    await flush();
    await giveUp(clock, () => assert.equal(recordings.liveRecording("s1", tab.id), undefined));
    assert.equal(fake.injections.length, RECORDER_ATTEMPTS);
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    const outcome = { status: "elsewhere", sameDocument: false, currentDocument: false };
    assert.deepEqual(warned(), [
      { event: "console_recording_retry", tabId: tab.id, ...outcome },
      {
        event: "console_recording_failed",
        tabId: tab.id,
        attempts: RECORDER_ATTEMPTS,
        ...outcome,
      },
    ]);
    clock.advance(RECORDER_RETRY_MS * 10);
    await flush();
    assert.equal(fake.injections.length, RECORDER_ATTEMPTS);
    assert.equal(clock.pending(), 0);
  });

  const PRESENT: [string, string | undefined, InjectionResult<unknown>, Record<string, unknown>][] =
    [
      ["no document", undefined, { frameId: 0, result: "present" }, {}],
      [
        "another document",
        "doc-new",
        { frameId: 0, result: "present", documentId: "doc-old" },
        { sameDocument: false, currentDocument: false },
      ],
    ];
  for (const [name, documentId, result, logged] of PRESENT) {
    it(`keeps a recorder present in ${name} once the attempts run out`, async (t) => {
      const warned = quiet(t);
      const { fake, recordings, clock, tabIn } = setup();
      const tab = await tabIn("s1");
      fake.injectionResults = [result];
      fake.emitCommitted({
        tabId: tab.id,
        frameId: 0,
        url: URL_A,
        ...(documentId === undefined ? {} : { documentId }),
      });
      await flush();
      await giveUp(clock, () => assert.equal(recordings.liveRecording("s1", tab.id), undefined));
      assert.equal(fake.injections.length, RECORDER_ATTEMPTS);
      assert.deepEqual(recordings.liveRecording("s1", tab.id), {
        since: START + RECORDER_RETRY_MS * (RECORDER_ATTEMPTS - 1),
      });
      assert.equal(clock.pending(), 0);
      assert.deepEqual(warned(), [
        { event: "console_recording_retry", tabId: tab.id, status: "present", ...logged },
        {
          event: "console_recording_started",
          tabId: tab.id,
          attempts: RECORDER_ATTEMPTS,
          status: "present",
          ...logged,
        },
      ]);
    });
  }

  it("keeps no recording when the injection keeps failing", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, clock, tabIn } = setup();
    const tab = await tabIn("s1");
    const inject = t.mock.method(fake.browser.scripting, "executeScript", async () => {
      throw new Error("Missing host permission for the tab");
    });
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    await giveUp(clock, () => assert.equal(recordings.liveRecording("s1", tab.id), undefined));
    assert.equal(inject.mock.callCount(), RECORDER_ATTEMPTS);
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    const error = "Error: Missing host permission for the tab";
    assert.deepEqual(warned(), [
      { event: "console_recording_retry", tabId: tab.id, status: "rejected", error },
      {
        event: "console_recording_failed",
        tabId: tab.id,
        attempts: RECORDER_ATTEMPTS,
        status: "rejected",
        error,
      },
    ]);
    inject.mock.restore();
    const failures: [InjectionResult<unknown>[], string][] = [
      [[{ frameId: 0, error: new Error("No window matching") }], "error"],
      [[], "missing"],
      [[{ frameId: 3 }], "missing"],
      [[{ frameId: 0, result: null }], "none"],
    ];
    for (const [results, status] of failures) {
      const before = warned().length;
      fake.injectionResults = results;
      fake.navigateByUser(tab.id, URL_A);
      await flush();
      await giveUp(clock, () => assert.equal(recordings.liveRecording("s1", tab.id), undefined));
      assert.equal(fake.injections.length, RECORDER_ATTEMPTS, JSON.stringify(results));
      fake.injections.length = 0;
      assert.equal(recordings.liveRecording("s1", tab.id), undefined, JSON.stringify(results));
      assert.deepEqual(warned().slice(before), [
        { event: "console_recording_retry", tabId: tab.id, status },
        {
          event: "console_recording_failed",
          tabId: tab.id,
          attempts: RECORDER_ATTEMPTS,
          status,
        },
      ]);
    }
  });

  const ENDS: [string, (fixture: ReturnType<typeof setup>, tab: FakeTab) => void][] = [
    [
      "a new commit",
      ({ fake }, tab) =>
        fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://c.example/" }),
    ],
    ["the tab leaving the group", ({ fake }, tab) => fake.ungroup(tab.id)],
    [
      "a withdrawal",
      ({ sessions, access }) => {
        sessions.set("s1", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
        access.forget("s1", SITE);
      },
    ],
    ["the tab closing", ({ fake }, tab) => fake.removeTab(tab.id)],
  ];
  for (const [name, end] of ENDS) {
    it(`stops injecting the recorder at ${name}`, async (t) => {
      const warned = quiet(t);
      const fixture = setup();
      const { fake, recordings, clock, tabIn } = fixture;
      const tab = await tabIn("s1");
      fake.injectionResults = [{ frameId: 0, result: "elsewhere", documentId: "doc-old" }];
      fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A, documentId: "doc-new" });
      await flush();
      assert.equal(fake.injections.length, 1);
      end(fixture, tab);
      await flush();
      assert.equal(recordings.liveRecording("s1", tab.id), undefined);
      clock.advance(RECORDER_RETRY_MS * RECORDER_ATTEMPTS);
      await flush();
      assert.equal(fake.injections.length, 1);
      assert.equal(clock.pending(), 0);
      const retry = {
        event: "console_recording_retry",
        tabId: tab.id,
        status: "elsewhere",
        sameDocument: false,
        currentDocument: false,
      };
      const dropped = { event: "console_recording_failed", tabId: tab.id, reason: "group" };
      assert.deepEqual(warned(), name === "the tab leaving the group" ? [retry, dropped] : [retry]);
    });
  }

  it("does not inject again when the document ends while the recorder is injected", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, clock, tabIn, sessions, access } = setup();
    const tab = await tabIn("s1");
    // Allowed by the session only, so no catch-up starts it again after the withdrawal.
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    fake.injectionResults = [{ frameId: 0, result: "elsewhere" }];
    const inject = fake.browser.scripting.executeScript;
    t.mock.method(fake.browser.scripting, "executeScript", async (...args: unknown[]) => {
      access.forget("s1", "https://b.example");
      return Reflect.apply(inject, fake.browser.scripting, args);
    });
    fake.navigateByUser(tab.id, "https://b.example/");
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    assert.equal(fake.injections.length, 1);
    assert.equal(clock.pending(), 0);
    assert.deepEqual(warned(), []);
  });

  it("drops a tab's recording at its next top-frame commit, at once", async () => {
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const first = recordings.liveRecording("s1", tab.id);
    assert.ok(first !== undefined);
    fake.emitCommitted({ tabId: tab.id, frameId: 1, url: "https://c.example/" });
    assert.equal(recordings.liveRecording("s1", tab.id), first);
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A });
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    await flush();
    const second = recordings.liveRecording("s1", tab.id);
    assert.ok(second !== undefined);
    assert.notEqual(second, first);
  });

  it("lets only the latest commit of a tab start a recording", async () => {
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A });
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: "https://c.example/" });
    await flush();
    assert.deepEqual(fake.injections, []);
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
  });

  it("drops the recording when the tab leaves the group or closes", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn, groups, access } = setup();
    const ungrouped = await tabIn("s1", URL_A);
    fake.ungroup(ungrouped.id);
    assert.equal(recordings.liveRecording("s1", ungrouped.id), undefined);

    const moved = await tabIn("s1", URL_A);
    access.admit("s2");
    await groups.ensureGroup("s2", moved);
    assert.equal(recordings.liveRecording("s1", moved.id), undefined);

    const closed = await tabIn("s1", URL_A);
    fake.removeTab(closed.id);
    assert.equal(recordings.liveRecording("s1", closed.id), undefined);

    const detached = await tabIn("s1", URL_A);
    const other = await tabIn("s1", URL_A);
    fake.emitDetached(detached.id);
    assert.equal(recordings.liveRecording("s1", detached.id), undefined);
    assert.ok(recordings.liveRecording("s1", other.id) !== undefined);
    fake.emitDetached(detached.id);
    assert.deepEqual(warned(), [
      { event: "console_recording_failed", tabId: ungrouped.id, reason: "group" },
      { event: "console_recording_failed", tabId: moved.id, reason: "group" },
      { event: "console_recording_failed", tabId: detached.id, reason: "detached" },
    ]);
  });

  it("drops the recording on any update that shows the tab in another group", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const live = recordings.liveRecording("s1", tab.id);
    fake.emitStatus(tab.id, "complete");
    assert.equal(recordings.liveRecording("s1", tab.id), live);
    const shown = fake.tabs.get(tab.id);
    assert.ok(shown !== undefined);
    // Without a groupId in the change: only the tab itself shows the move.
    shown.groupId = -1;
    fake.emitStatus(tab.id, "complete");
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    assert.deepEqual(warned(), [
      { event: "console_recording_failed", tabId: tab.id, reason: "group" },
    ]);
  });

  it("drops the recording when the tab shows another site without a commit", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const live = recordings.liveRecording("s1", tab.id);
    fake.pushState(tab.id, `${SITE}/other#part`);
    assert.equal(recordings.liveRecording("s1", tab.id), live);
    // A site change without a commit (a restore from memory does commit, ADR 0049): a new URL.
    fake.pushState(tab.id, "https://b.example/");
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    assert.deepEqual(warned(), [
      {
        event: "console_recording_failed",
        tabId: tab.id,
        reason: "site",
        site: "https://b.example",
      },
    ]);
  });

  it("keeps the recording on a late event for the group it was made in", async () => {
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const live = recordings.liveRecording("s1", tab.id);
    const groupId = fake.tabs.get(tab.id)?.groupId ?? -1;
    await fake.browser.tabs.group({ groupId, tabIds: [tab.id] });
    fake.emitStatus(tab.id, "complete");
    assert.equal(recordings.liveRecording("s1", tab.id), live);
  });

  it("does not start for a tab that closed while the commit was checked", async () => {
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.navigateByUser(tab.id, URL_A);
    fake.removeTab(tab.id);
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    assert.deepEqual(fake.injections, []);
  });

  it("drops the recordings of a site the user withdraws from the session", async () => {
    const { recordings, tabIn, sessions, access } = setup();
    sessions.set("s1", {
      allowed: new Set(["https://b.example", "https://c.example"]),
      refused: new Set(),
      closed: 0,
    });
    sessions.set("s2", {
      allowed: new Set(["https://b.example", "https://c.example"]),
      refused: new Set(),
      closed: 0,
    });
    const withdrawn = await tabIn("s1", "https://b.example/");
    const otherSite = await tabIn("s1", "https://c.example/");
    const otherSession = await tabIn("s2", "https://b.example/");
    access.forget("s1", "https://b.example");
    assert.equal(recordings.liveRecording("s1", withdrawn.id), undefined);
    assert.ok(recordings.liveRecording("s1", otherSite.id) !== undefined);
    assert.ok(recordings.liveRecording("s2", otherSession.id) !== undefined);
    access.forget("s2", "https://c.example");
    assert.ok(recordings.liveRecording("s2", otherSession.id) !== undefined);
  });

  it("drops a recording withdrawn while the recorder is injected", async (t) => {
    const { fake, recordings, tabIn, sessions, access } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1");
    const inject = fake.browser.scripting.executeScript;
    const executeScript = t.mock.method(
      fake.browser.scripting,
      "executeScript",
      async (...args: unknown[]) => {
        executeScript.mock.restore();
        access.forget("s1", "https://b.example");
        // Approved again at once: only dropping it at the withdrawal shows the gap.
        sessions.set("s1", {
          allowed: new Set(["https://b.example"]),
          refused: new Set(),
          closed: 0,
        });
        return Reflect.apply(inject, fake.browser.scripting, args);
      },
    );
    fake.navigateByUser(tab.id, "https://b.example/");
    await flush();
    // The commit's recording holds the gap: what is live is a new one, started after it.
    assert.deepEqual(
      fake.injections.map((injection) => injection.args?.[2]),
      [false, true],
    );
    assert.deepEqual(recordings.liveRecording("s1", tab.id), { since: START });
  });

  it("drops a recording whose tab left the group while the commit was checked", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn, groups } = setup();
    const tab = await tabIn("s1");
    const read = fake.browser.storage.local.get;
    let moved = false;
    // The gate reads storage after it read the tab's group; the tab leaves, unseen, while it waits.
    t.mock.method(fake.browser.storage.local, "get", async (...args: unknown[]) => {
      const stored = await Reflect.apply(read, fake.browser.storage.local, args);
      const shown = fake.tabs.get(tab.id);
      if (!moved && shown !== undefined) {
        moved = true;
        shown.groupId = -1;
      }
      return stored;
    });
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.equal(fake.injections.length, 1);
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    // Back in the group: the records from the gap are still not read.
    await groups.ensureGroup("s1", tab);
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    assert.deepEqual(warned(), [
      { event: "console_recording_failed", tabId: tab.id, reason: "group" },
    ]);
  });

  it("drops the recordings of a session that ends", async () => {
    const { recordings, tabIn, sessions, access } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1", "https://b.example/");
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
    access.endSession("s1");
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
  });

  it("starts no recorder in its tabs once the session ended, also on a site allowed always", async () => {
    const { fake, recordings, tabIn, access } = setup();
    const tab = await tabIn("s1", URL_A);
    const injected = fake.injections.length;
    access.endSession("s1");
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    assert.equal(fake.injections.length, injected);
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
  });

  it("drops a recording once stored access no longer allows its site", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn } = setup();
    await grantSite(fake.browser, "https://b.example");
    const revoked = await tabIn("s1", "https://b.example/");
    const blocked = await tabIn("s1", URL_A);
    const kept = await tabIn("s1", URL_A);
    fake.ungroup(kept.id);
    const live = await tabIn("s1", "https://b.example/");
    await revokeSite(fake.browser, "https://b.example");
    await flush();
    assert.equal(recordings.liveRecording("s1", revoked.id), undefined);
    assert.equal(recordings.liveRecording("s1", live.id), undefined);
    assert.ok(recordings.liveRecording("s1", blocked.id) !== undefined);
    await fake.browser.storage.local.set({ blocklist: ["a.example"] });
    await flush();
    assert.equal(recordings.liveRecording("s1", blocked.id), undefined);
    const event = "console_recording_failed";
    assert.deepEqual(warned(), [
      { event, tabId: kept.id, reason: "group" },
      { event, tabId: revoked.id, reason: "refused", code: "site_not_approved" },
      { event, tabId: live.id, reason: "refused", code: "site_not_approved" },
      { event, tabId: blocked.id, reason: "refused", code: "site_blocked" },
    ]);
  });

  it("keeps a recording through a storage change that leaves its site allowed", async () => {
    const { fake, recordings, tabIn, sessions } = setup();
    sessions.set("s1", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1", URL_A);
    const live = recordings.liveRecording("s1", tab.id);
    await grantSite(fake.browser, "https://b.example");
    await revokeSite(fake.browser, SITE);
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), live);
  });

  it("rechecks only on a change to local storage", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn, sessions } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1", "https://b.example/");
    // Not through forget, which drops it at once.
    sessions.get("s1")?.allowed.delete("https://b.example");
    fake.emitStorageChanged("session");
    await flush();
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
    fake.emitStorageChanged("local");
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    assert.equal(warned().length, 1);
  });

  it("drops a recording when storage cannot be read to recheck it", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    fake.browser.storage.local.get = async () => {
      throw new Error("storage is unavailable");
    };
    fake.emitStorageChanged("local");
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    assert.deepEqual(warned(), [
      {
        event: "console_recording_failed",
        tabId: tab.id,
        error: "Error: storage is unavailable",
      },
    ]);
  });
});

describe("console recording of a page already open when access begins", { timeout: 10000 }, () => {
  it("starts or empties the recorder once, and records from when that returned", async (t) => {
    const warned = quiet(t);
    for (const status of ["started", "cleared"]) {
      const { fake, recordings, clock, access, tabIn } = setup();
      const tab = await tabIn("s1", URL_B);
      fake.setFrames(tab.id, [{ frameId: 0, url: URL_B, documentId: "doc-b" }]);
      fake.injectionResults = [{ frameId: 0, result: status, documentId: "doc-b" }];
      clock.advance(25);
      await access.allowForSession("s1", [OTHER], () => true);
      await flush();
      assert.deepEqual(
        fake.injections.map(({ args }) => args),
        [[OTHER, RECORDER_OPTIONS, true]],
        status,
      );
      assert.deepEqual(recordings.liveRecording("s1", tab.id), { since: START + 25 }, status);
      assert.equal(recordings.liveRecording("s2", tab.id), undefined, status);
      assert.equal(clock.pending(), 0, status);
    }
    assert.deepEqual(warned(), []);
  });

  it("exposes nothing until the injection returned", async (t) => {
    const { fake, recordings, access, tabIn } = setup();
    const tab = await tabIn("s1", URL_B);
    const inject = fake.browser.scripting.executeScript;
    const held = Promise.withResolvers<void>();
    t.mock.method(fake.browser.scripting, "executeScript", async (...args: unknown[]) => {
      await held.promise;
      return Reflect.apply(inject, fake.browser.scripting, args);
    });
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    held.resolve();
    await flush();
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
  });

  const UNCONFIRMED: [string, InjectionResult<unknown>[] | Error, Record<string, unknown>][] = [
    ["present", [{ frameId: 0, result: "present", documentId: "doc-b" }], { status: "present" }],
    [
      "uncleared",
      [{ frameId: 0, result: "uncleared", documentId: "doc-b" }],
      { status: "uncleared" },
    ],
    [
      "elsewhere",
      [{ frameId: 0, result: "elsewhere", documentId: "doc-b" }],
      { status: "elsewhere" },
    ],
    ["refused", [{ frameId: 0, result: "refused", documentId: "doc-b" }], { status: "refused" }],
    [
      "another document",
      [{ frameId: 0, result: "cleared", documentId: "doc-old" }],
      { status: "cleared", sameDocument: false },
    ],
    ["no top frame", [{ frameId: 2, result: "started" }], { status: "missing" }],
    [
      "a rejected injection",
      new Error("Missing host permission for the tab"),
      { status: "rejected", error: "Error: Missing host permission for the tab" },
    ],
  ];
  for (const [name, answer, logged] of UNCONFIRMED) {
    it(`records nothing, once, after ${name}`, async (t) => {
      const warned = quiet(t);
      const { fake, recordings, clock, access, tabIn } = setup();
      const tab = await tabIn("s1", URL_B);
      fake.setFrames(tab.id, [{ frameId: 0, url: URL_B, documentId: "doc-b" }]);
      if (answer instanceof Error) fake.failNextInjection(answer);
      else fake.injectionResults = answer;
      await access.allowForSession("s1", [OTHER], () => true);
      await flush();
      assert.equal(recordings.liveRecording("s1", tab.id), undefined);
      clock.advance(RECORDER_RETRY_MS * RECORDER_ATTEMPTS);
      await flush();
      assert.equal(fake.injections.length, 1);
      assert.equal(recordings.liveRecording("s1", tab.id), undefined);
      const sameDocument = logged.sameDocument === false ? {} : { sameDocument: true };
      assert.deepEqual(warned(), [
        {
          event: "console_recording_failed",
          tabId: tab.id,
          attempts: 1,
          ...(answer instanceof Error || logged.status === "missing" ? {} : sameDocument),
          ...logged,
          currentDocument: true,
        },
      ]);
    });
  }

  it("tries again at the next approval after a recorder that would not empty", async (t) => {
    quiet(t);
    const { fake, recordings, access, tabIn } = setup();
    const tab = await tabIn("s1", URL_B);
    fake.injectionResults = [{ frameId: 0, result: "uncleared" }];
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    fake.injectionResults = [{ frameId: 0, result: "cleared" }];
    await access.allowForSession("s1", ["https://c.example"], () => true);
    await flush();
    assert.equal(fake.injections.length, 2);
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
  });

  it("records after an empty recorder when Firefox names no document, unless it changed", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, access, tabIn } = setup();
    const tab = await tabIn("s1", URL_B);
    fake.setFrames(tab.id, [{ frameId: 0, url: URL_B }]);
    fake.injectionResults = [{ frameId: 0, result: "cleared" }];
    await access.allowForSession("s1", [OTHER], () => true);
    await flush();
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);

    const other = await tabIn("s2", URL_B);
    fake.setFrames(other.id, [{ frameId: 0, url: URL_B }]);
    const inject = fake.browser.scripting.executeScript;
    const executeScript = t.mock.method(
      fake.browser.scripting,
      "executeScript",
      async (...args: unknown[]) => {
        executeScript.mock.restore();
        // Withdrawn while the recorder is emptied: that live document ended.
        access.forget("s2", OTHER);
        return Reflect.apply(inject, fake.browser.scripting, args);
      },
    );
    await access.allowForSession("s2", [OTHER], () => true);
    await flush();
    assert.equal(recordings.liveRecording("s2", other.id), undefined);
    assert.deepEqual(warned(), []);
  });
});

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  fake.injectionResults = [{ frameId: 0, result: "started" }];
  // Its own clock: advancing it runs no site-access timer.
  const clock = createFakeTimers();
  const recordings = createConsoleRecording({
    browser: fake.browser,
    groups,
    access,
    timers: clock,
    now: () => START + clock.now(),
  });

  /** A tab in the session's group, on `url` with A's site stored as approved. */
  async function tabIn(session: string, url?: string): Promise<FakeTab> {
    // A group exists only after its session's first request admitted it.
    access.admit(session);
    await grantSite(fake.browser, SITE);
    const tab = fake.openTab();
    await groups.ensureGroup(session, tab);
    if (url !== undefined) {
      fake.navigateByUser(tab.id, url);
      await flush();
    }
    return tab;
  }

  return { fake, groups, sessions, access, recordings, clock, tabIn };
}

/** Keeps the recording's log lines out of the test output; returns a reader for them. */
function quiet(t: TestContext): () => Record<string, unknown>[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}

/** Moves the clock through every retry of the recorder, checking `during` before each. */
async function giveUp(clock: FakeTimers, during: () => void): Promise<void> {
  for (let attempt = 1; attempt < RECORDER_ATTEMPTS; attempt += 1) {
    during();
    clock.advance(RECORDER_RETRY_MS);
    await flush();
  }
}
