import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { InjectionResult } from "./browser-api.ts";
import { RECORDER_OPTIONS } from "./console-messages.ts";
import { recordConsole } from "./console-recorder.ts";
import { type ConsoleRecording, createConsoleRecording } from "./console-recording.ts";
import { createFakeBrowser, createFakeTimers, type FakeTab, flush } from "./fake-browser.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite } from "./settings.ts";
import { createSiteAccess, PROMPT_PAGE, type SessionMemory } from "./site-access.ts";

const SITE = "https://a.example";
const URL_A = `${SITE}/page`;

describe("console recording", { timeout: 10000 }, () => {
  it("starts the recorder in the top frame of a committed page on an approved site", async () => {
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.deepEqual(fake.injections, [
      {
        tabId: tab.id,
        func: recordConsole,
        args: [SITE, RECORDER_OPTIONS],
        world: "MAIN",
        injectImmediately: true,
        frameIds: [0],
      },
    ]);
    const live = recordings.liveRecording("s1", tab.id);
    assert.ok(live !== undefined);
    assert.equal(recordings.liveRecording("s1", tab.id), live);
    assert.equal(recordings.liveRecording("s2", tab.id), undefined);
  });

  it("starts it for a site the session approved, and for a stored one", async () => {
    const { fake, recordings, tabIn, sessions } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1");
    fake.navigateByUser(tab.id, "https://b.example/");
    await flush();
    assert.equal(fake.injections.length, 1);
    assert.deepEqual(fake.injections[0]?.args, ["https://b.example", RECORDER_OPTIONS]);
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
  });

  it("gates the committed URL, not the tab's", async () => {
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1", "https://b.example/");
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A });
    await flush();
    assert.deepEqual(fake.injections[0]?.args, [SITE, RECORDER_OPTIONS]);
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
    await access.ask("s1", "https://c.example/", tab.id);
    assert.equal(access.openPrompt("s1")?.tabId, tab.id);
    fake.injections.length = 0;
    fake.emitCommitted({ tabId: tab.id, frameId: 0, url: URL_A });
    await flush();
    assert.deepEqual(fake.injections, []);
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
  });

  it("keeps no recording when the injection fails", async (t) => {
    const warned = quiet(t);
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1");
    fake.failNextInjection(new Error("Missing host permission for the tab"));
    fake.navigateByUser(tab.id, URL_A);
    await flush();
    assert.equal(fake.injections.length, 1);
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
    assert.deepEqual(warned(), [
      {
        event: "console_recording_failed",
        tabId: tab.id,
        error: "Error: Missing host permission for the tab",
      },
    ]);
    const failures: InjectionResult<unknown>[][] = [
      [{ frameId: 0, error: new Error("No window matching") }],
      [],
      [{ frameId: 3 }],
    ];
    for (const results of failures) {
      fake.injectionResults = results;
      fake.navigateByUser(tab.id, URL_A);
      await flush();
      assert.equal(recordings.liveRecording("s1", tab.id), undefined, JSON.stringify(results));
    }
    assert.equal(warned().length, 1);
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

  it("drops the recording when the tab leaves the group or closes", async () => {
    const { fake, recordings, tabIn, groups } = setup();
    const ungrouped = await tabIn("s1", URL_A);
    fake.ungroup(ungrouped.id);
    assert.equal(recordings.liveRecording("s1", ungrouped.id), undefined);

    const moved = await tabIn("s1", URL_A);
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
  });

  it("drops the recording on any update that shows the tab in another group", async () => {
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
  });

  it("drops the recording when the tab shows another site without a commit", async () => {
    const { fake, recordings, tabIn } = setup();
    const tab = await tabIn("s1", URL_A);
    const live = recordings.liveRecording("s1", tab.id);
    fake.pushState(tab.id, `${SITE}/other#part`);
    assert.equal(recordings.liveRecording("s1", tab.id), live);
    // As a page from another site restored from the back-forward cache: no commit, a new URL.
    fake.pushState(tab.id, "https://b.example/");
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
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
    sessions.set("s2", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const withdrawn = await tabIn("s1", "https://b.example/");
    const otherSite = await tabIn("s1", "https://c.example/");
    const otherSession = await tabIn("s2", "https://b.example/");
    access.forget("s1", "https://b.example");
    assert.equal(recordings.liveRecording("s1", withdrawn.id), undefined);
    assert.ok(recordings.liveRecording("s1", otherSite.id) !== undefined);
    assert.ok(recordings.liveRecording("s2", otherSession.id) !== undefined);
    recordings.withdraw("s2", "https://c.example");
    assert.ok(recordings.liveRecording("s2", otherSession.id) !== undefined);
  });

  it("drops a recording withdrawn while the recorder is injected", async (t) => {
    const { fake, recordings, tabIn, sessions, access } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1");
    const inject = fake.browser.scripting.executeScript;
    t.mock.method(fake.browser.scripting, "executeScript", async (...args: unknown[]) => {
      access.forget("s1", "https://b.example");
      // Approved again at once: only dropping it at the withdrawal shows the gap.
      sessions.set("s1", {
        allowed: new Set(["https://b.example"]),
        refused: new Set(),
        closed: 0,
      });
      return Reflect.apply(inject, fake.browser.scripting, args);
    });
    fake.navigateByUser(tab.id, "https://b.example/");
    await flush();
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
  });

  it("drops a recording whose tab left the group while the commit was checked", async (t) => {
    const { fake, recordings, tabIn, groups } = setup();
    const tab = await tabIn("s1");
    const read = fake.browser.storage.local.get;
    let moved = false;
    // The gate reads storage after it read the tab's group; the tab leaves while it waits.
    t.mock.method(fake.browser.storage.local, "get", async (...args: unknown[]) => {
      const stored = await Reflect.apply(read, fake.browser.storage.local, args);
      if (!moved) {
        moved = true;
        fake.ungroup(tab.id);
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
  });

  it("drops the recordings of a session that ends", async () => {
    const { recordings, tabIn, sessions, access } = setup();
    sessions.set("s1", { allowed: new Set(["https://b.example"]), refused: new Set(), closed: 0 });
    const tab = await tabIn("s1", "https://b.example/");
    assert.ok(recordings.liveRecording("s1", tab.id) !== undefined);
    access.endSession("s1");
    assert.equal(recordings.liveRecording("s1", tab.id), undefined);
  });

  it("drops a recording once stored access no longer allows its site", async () => {
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

  it("rechecks only on a change to local storage", async () => {
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

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const withdrawn: ConsoleRecording["withdraw"] = (session, site) =>
    recordings.withdraw(session, site);
  const access = createSiteAccess({
    browser: fake.browser,
    groups,
    sessions,
    timers,
    onWithdraw: withdrawn,
  });
  const recordings = createConsoleRecording({ browser: fake.browser, groups, access });

  /** A tab in the session's group, on `url` with A's site stored as approved. */
  async function tabIn(session: string, url?: string): Promise<FakeTab> {
    await grantSite(fake.browser, SITE);
    const tab = fake.openTab();
    await groups.ensureGroup(session, tab);
    if (url !== undefined) {
      fake.navigateByUser(tab.id, url);
      await flush();
    }
    return tab;
  }

  return { fake, groups, sessions, access, recordings, tabIn };
}

/** Keeps the recording's log lines out of the test output; returns a reader for them. */
function quiet(t: TestContext): () => Record<string, unknown>[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}
