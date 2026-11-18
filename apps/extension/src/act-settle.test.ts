import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActAfter } from "@foxleash/protocol";
import {
  createActSettle,
  MIN_SETTLE_MS,
  QUIET_MS,
  RESPONSE_WAIT_MS,
  SETTLE_CAP_MS,
} from "./act-settle.ts";
import {
  createFakeBrowser,
  createFakeTimers,
  type FakeTab,
  type FakeTimers,
  flush,
} from "./fake-browser.ts";
import { MAX_REFUSALS } from "./file-guard.ts";
import { NAVIGATION_WAIT_MS, ToolError } from "./handlers.ts";
import type { RequestCounts } from "./network-log.ts";
import { PAGE_REQUEST_MS } from "./page-scripts.ts";
import { MAX_FIELD_CHARS } from "./page-tree.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite } from "./settings.ts";
import { createSiteAccess } from "./site-access.ts";
import { createTabNavigations } from "./tab-navigations.ts";

const SITE = "https://a.example";
const NEXT = `${SITE}/next`;
const OTHER = "https://b.example";
/** The clock steps the tests run in, in ms. */
const STEP = 10;
const BUTTON = { role: "button", name: "Save" };
const WATCHED = { watch: "w.1", element: BUTTON };

describe("act settle", { timeout: 10000 }, () => {
  describe("on a page that stays", () => {
    it("answers unchanged once the page has been quiet for QUIET_MS", async () => {
      const { act, finish, polls, generations } = await started();
      const { after } = await act(WATCHED, undefined, 7);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unchanged" });
      assert.equal(elapsed, QUIET_MS);
      assert.deepEqual(polls, [
        { session: "s1", tabId: polls[0]?.tabId, type: "page_changes", params: { watch: "w.1" } },
        { session: "s1", tabId: polls[0]?.tabId, type: "page_changes", params: { watch: "w.1" } },
      ]);
      assert.deepEqual(generations, [7, 7]);
    });

    it("answers changed when the page changed, and waits until it is quiet again", async () => {
      const { act, finish, page, timers } = await started();
      const { after } = await act();
      page.changes = 1;
      timers.setTimeout(() => page.change(), 60);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "changed" });
      assert.equal(elapsed, 60 + QUIET_MS);
    });

    it("answers unsettled at the cap, and no later, for a page that never goes quiet", async () => {
      const { act, finish, page } = await started();
      page.restless = true;
      const { after } = await act();
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unsettled" });
      assert.equal(elapsed, SETTLE_CAP_MS);
    });

    it("never ends the quiet path sooner than MIN_SETTLE_MS after the reply", async () => {
      const { act, finish, page } = await started();
      page.quietMs = 150.5;
      const { after } = await act();
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unchanged" });
      assert.equal(elapsed, MIN_SETTLE_MS);
    });

    it("waits for a request the page began after the act, and counts it", async () => {
      const { act, finish, network, timers, sentAt } = await started();
      network.begun = 2;
      network.open = 1;
      const { after } = await act();
      timers.setTimeout(() => {
        network.open = 0;
      }, 300);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unchanged", requests: 2 });
      assert.equal(elapsed, 300);
      assert.ok(network.sinces.length > 0);
      assert.ok(network.sinces.every((since) => since === sentAt()));
    });

    it("waits QUIET_MS after the last request ended, for the page to show what it brought", async () => {
      for (const renders of [false, true]) {
        const { act, finish, network, page, timers, sentAt } = await started();
        network.begun = 1;
        network.open = 1;
        const { after } = await act();
        timers.setTimeout(() => {
          network.open = 0;
          network.lastEnd = sentAt() + 300;
        }, 300);
        if (renders) timers.setTimeout(() => page.change(), 320);
        const { value, elapsed } = await finish(after);
        const expected = renders ? "changed" : "unchanged";
        assert.deepEqual(value, { element: BUTTON, page: expected, requests: 1 });
        assert.equal(elapsed, renders ? 320 + QUIET_MS + 30 : 300 + QUIET_MS);
      }
    });

    it("waits for the page to show a fetch's answer, from the answer on", async () => {
      for (const spinner of [false, true]) {
        const { act, finish, network, page, timers, sentAt } = await started();
        network.begun = 1;
        network.open = 1;
        const { after } = await act();
        if (spinner) timers.setTimeout(() => page.change(), 100);
        answerAt(300, network, timers, sentAt);
        timers.setTimeout(() => page.change(), 600);
        const { value, elapsed } = await finish(after);
        assert.deepEqual(value, { element: BUTTON, page: "changed", requests: 1 });
        assert.equal(elapsed, 600 + QUIET_MS);
        assert.ok(network.sinces.every((since) => since === sentAt()));
      }
    });

    it("answers unchanged RESPONSE_WAIT_MS after a fetch's answer the page did not show", async () => {
      const { act, finish, network, timers, sentAt } = await started();
      network.begun = 1;
      network.open = 1;
      const { after } = await act();
      answerAt(300, network, timers, sentAt);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unchanged", requests: 1 });
      assert.equal(elapsed, 300 + RESPONSE_WAIT_MS);
      assert.ok(network.sinces.every((since) => since === sentAt()));
    });

    it("waits RESPONSE_WAIT_MS after a fetch that answers at once on a page that never changed", async () => {
      const { act, finish, network, page, timers, sentAt, answerWith } = await started();
      network.begun = 1;
      network.open = 1;
      // With no change the quiet time counts from the watch's start, and it reaches the background
      // a poll's return trip after the page read it.
      answerWith(async () => ({
        state: "current",
        changes: page.changes,
        quietMs: Math.max(timers.now() - page.lastChange - 20, 0),
      }));
      const { after } = await act();
      answerAt(0, network, timers, sentAt);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unchanged", requests: 1 });
      assert.equal(elapsed, RESPONSE_WAIT_MS);
    });

    it("sees a change late in the window that the page read after a poll's answer returned", async () => {
      const { act, finish, network, page, timers, sentAt, answerWith } = await started();
      network.begun = 1;
      network.open = 1;
      // The page reads itself when asked, and its answer arrives a 20 ms return trip later.
      answerWith(async () => {
        const read = {
          state: "current",
          changes: page.changes,
          quietMs: timers.now() - page.lastChange,
        };
        await new Promise<void>((resolve) => timers.setTimeout(resolve, 20));
        return read;
      });
      const { after } = await act();
      answerAt(340, network, timers, sentAt);
      timers.setTimeout(() => page.change(), 340 + RESPONSE_WAIT_MS - 10);
      const { value } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "changed", requests: 1 });
    });

    it("waits only QUIET_MS after a change that followed a fetch's answer", async () => {
      const { act, finish, network, page, timers, sentAt } = await started();
      network.begun = 1;
      network.open = 1;
      const { after } = await act();
      answerAt(300, network, timers, sentAt);
      timers.setTimeout(() => page.change(), 320);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "changed", requests: 1 });
      assert.equal(elapsed, 320 + QUIET_MS);
    });

    it("does not take a change in the same ms as a fetch's answer for the page showing it", async () => {
      const { act, finish, network, page, timers, sentAt } = await started();
      network.begun = 1;
      network.open = 1;
      const { after } = await act();
      answerAt(300, network, timers, sentAt);
      timers.setTimeout(() => page.change(), 300);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "changed", requests: 1 });
      assert.equal(elapsed, 300 + RESPONSE_WAIT_MS);
    });

    it("answers by the count at the cap when it cuts the wait after a fetch's answer", async () => {
      const { act, finish, network, timers, sentAt } = await started();
      network.begun = 1;
      network.open = 1;
      const { after } = await act();
      answerAt(SETTLE_CAP_MS - 300, network, timers, sentAt);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unchanged", requests: 1 });
      assert.equal(elapsed, SETTLE_CAP_MS);
    });

    it("answers unsettled at the cap when a request ended just before it", async () => {
      const { act, finish, network, timers, sentAt } = await started();
      network.begun = 1;
      network.open = 1;
      const { after } = await act();
      timers.setTimeout(() => {
        network.open = 0;
        network.lastEnd = sentAt() + SETTLE_CAP_MS - 60;
      }, SETTLE_CAP_MS - 60);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unsettled", requests: 1 });
      assert.equal(elapsed, SETTLE_CAP_MS);
    });

    it("answers unsettled at the cap while a request the act began is still open", async () => {
      const { act, finish, network } = await started();
      network.begun = 1;
      network.open = 1;
      const { after } = await act();
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unsettled", requests: 1 });
      assert.equal(elapsed, SETTLE_CAP_MS);
    });

    it("answers the last quiet poll's outcome by its count when time runs out before the next", async () => {
      for (const changes of [0, 3]) {
        const { settle, finish, page, tab, timers } = await started();
        page.changes = changes;
        page.quietMs = QUIET_MS;
        const watch = settle.begin("s1", tab.id, 0);
        await flush();
        watch.sent();
        // The deadline passes within MIN_SETTLE_MS of the reply, after a quiet poll.
        timers.advance(PAGE_REQUEST_MS - STEP);
        const { value, elapsed } = await finish(watch.after(WATCHED));
        watch.stop();
        assert.deepEqual(value, { element: BUTTON, page: changes > 0 ? "changed" : "unchanged" });
        assert.equal(elapsed, STEP);
      }
    });

    it("leaves requests out when the page began none", async () => {
      const { act, finish } = await started();
      const { after } = await act();
      const { value } = await finish(after);
      assert.equal(Object.hasOwn(value, "requests"), false);
    });

    it("answers unknown when another act started a watch in the document", async () => {
      const { act, finish, page, polls } = await started();
      page.state = "superseded";
      const { after } = await act();
      assert.deepEqual((await finish(after)).value, { element: BUTTON, page: "unknown" });
      assert.equal(polls.length, 1);
    });

    it("answers unknown for an answer it cannot read", async () => {
      for (const answer of [
        null,
        "current",
        { state: "current", changes: -1, quietMs: 0 },
        { state: "current", changes: 1.5, quietMs: 0 },
        { state: "current", changes: "1", quietMs: 0 },
        { state: "current", changes: 0, quietMs: -1 },
        { state: "current", changes: 0, quietMs: Number.POSITIVE_INFINITY },
        { state: "current", changes: 0 },
        { state: "gone" },
        Object.create({ state: "current", changes: 0, quietMs: 500 }),
      ]) {
        const { act, finish, answerWith } = await started();
        answerWith(async () => answer);
        const { after } = await act();
        assert.deepEqual((await finish(after)).value, { element: BUTTON, page: "unknown" });
      }
    });

    it("ends without an error when a poll fails, and does not poll again", async () => {
      for (const failure of [
        new ToolError("site_not_approved", "No."),
        new ToolError("tab_not_in_group", "No."),
        new Error("boom"),
      ]) {
        const { act, finish, answerWith, polls } = await started();
        answerWith(() => Promise.reject(failure));
        const { after } = await act();
        assert.deepEqual((await finish(after)).value, { element: BUTTON, page: "unknown" });
        assert.equal(polls.length, 1);
      }
    });

    it("ends without an error when the tab closed during the wait", async () => {
      const { act, finish, fake, tab, timers, answerWith, polls } = await started();
      answerWith(async () => {
        throw new ToolError("tab_not_found", "Gone.");
      });
      const { after } = await act({ ...WATCHED });
      timers.setTimeout(() => fake.removeTab(tab.id), 5);
      assert.deepEqual((await finish(after)).value, { element: BUTTON, page: "unknown" });
      assert.equal(polls.length, 1);
    });

    it("lets a poll that loses the race with the cap finish, and ignores it", async () => {
      const { act, finish, answerWith, page, timers } = await started();
      page.restless = true;
      const { promise: held, resolve } = Promise.withResolvers<unknown>();
      let polls = 0;
      answerWith(() => {
        polls += 1;
        if (polls > 1) return held;
        return Promise.resolve({ state: "current", changes: 1, quietMs: 0 });
      });
      const { after } = await act();
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unsettled" });
      assert.equal(elapsed, SETTLE_CAP_MS);
      resolve({ state: "current", changes: 1, quietMs: 1000 });
      await flush();
      timers.advance(1000);
      assert.equal(polls, 2);
    });
  });

  describe("on a navigation", () => {
    it("waits for the page the act loads, and reports its address", async () => {
      const { act, finish, fake, tab, timers, waits, polls, network } = await started();
      network.begun = 4;
      const { after } = await act(WATCHED, () => begin(fake, tab.id, NEXT));
      timers.setTimeout(() => land(fake, tab.id, NEXT), 700);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "loaded", url: NEXT });
      assert.equal(elapsed, 700);
      assert.deepEqual(waits, [NAVIGATION_WAIT_MS]);
      assert.deepEqual(polls, []);
    });

    it("shows only the site of a page on a site the session may not act on", async () => {
      const { act, finish, fake, tab, timers } = await started();
      const { after } = await act(WATCHED, () => begin(fake, tab.id, `${OTHER}/secret`));
      timers.setTimeout(() => land(fake, tab.id, `${OTHER}/secret`), 100);
      const { value } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "loaded", url: OTHER });
    });

    it("reports a page not committed at the bound as loading, without an address", async () => {
      const { act, finish, fake, tab, waits } = await started();
      const { after } = await act(WATCHED, () => begin(fake, tab.id, NEXT));
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "loading" });
      assert.equal(elapsed, NAVIGATION_WAIT_MS);
      assert.deepEqual(waits, [NAVIGATION_WAIT_MS]);
    });

    it("reports a page committed but still parsing at the bound as loading, with its address", async () => {
      const { act, finish, fake, tab, timers } = await started();
      const { after } = await act(WATCHED, () => begin(fake, tab.id, NEXT));
      timers.setTimeout(() => commit(fake, tab.id, NEXT), 100);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "loading", url: NEXT });
      assert.equal(elapsed, NAVIGATION_WAIT_MS);
    });

    it("follows a navigation that begins during the quiet wait", async () => {
      const { act, finish, fake, tab, timers, polls } = await started();
      const { after } = await act();
      timers.setTimeout(() => begin(fake, tab.id, NEXT), 30);
      timers.setTimeout(() => land(fake, tab.id, NEXT), 400);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "loaded", url: NEXT });
      assert.equal(elapsed, 400);
      assert.equal(polls.length, 1);
    });

    it("follows a navigation that began before the cap, after the cap", async () => {
      const { act, finish, fake, tab, timers, page } = await started();
      page.restless = true;
      const { after } = await act();
      timers.setTimeout(() => begin(fake, tab.id, NEXT), SETTLE_CAP_MS - 1);
      timers.setTimeout(() => land(fake, tab.id, NEXT), SETTLE_CAP_MS + 500);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "loaded", url: NEXT });
      assert.equal(elapsed, SETTLE_CAP_MS + 500);
    });

    it("reports loaded when the navigation ends and another document answers", async () => {
      const { act, finish, fake, tab, page, waits } = await started();
      page.state = "other";
      // A page from the back-forward cache: no commit, only the tab's completion.
      const { after } = await act(WATCHED, () => {
        begin(fake, tab.id, NEXT);
        show(fake, tab.id, NEXT);
        fake.emitStatus(tab.id, "complete");
      });
      const { value } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "loaded", url: NEXT });
      assert.deepEqual(waits, [NAVIGATION_WAIT_MS]);
    });

    it("waits for the same document to go quiet when the navigation ended without another", async () => {
      const { act, finish, fake, tab, timers, waits } = await started();
      const { after } = await act(WATCHED, () => begin(fake, tab.id, NEXT));
      // A 204 or a download: the navigation ends and the page stays.
      timers.setTimeout(() => fake.emitStatus(tab.id, "complete"), 20);
      const { value, elapsed } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unchanged" });
      assert.equal(elapsed, QUIET_MS);
      assert.deepEqual(waits, [NAVIGATION_WAIT_MS]);
    });

    it("waits for a navigation once, also when it found none under way", async () => {
      const { act, finish, fake, tab, timers, waits } = await started();
      const { after } = await act(WATCHED, () => {
        begin(fake, tab.id, NEXT);
        fake.emitStatus(tab.id, "complete");
      });
      timers.setTimeout(() => begin(fake, tab.id, `${SITE}/last`), 30);
      const { value } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "loading" });
      assert.deepEqual(waits, [NAVIGATION_WAIT_MS]);
    });

    it("reports the tab closed when it closes during the navigation", async () => {
      const { act, finish, fake, tab, timers } = await started();
      const { after } = await act(WATCHED, () => begin(fake, tab.id, NEXT));
      timers.setTimeout(() => fake.removeTab(tab.id), 50);
      assert.deepEqual((await finish(after)).value, { element: BUTTON, page: "closed" });
    });

    it("gives no address once the tab left the session's group", async () => {
      const { act, finish, fake, tab, timers } = await started();
      const { after } = await act(WATCHED, () => begin(fake, tab.id, NEXT));
      timers.setTimeout(() => {
        fake.ungroup(tab.id);
        land(fake, tab.id, NEXT);
      }, 100);
      assert.deepEqual((await finish(after)).value, { element: BUTTON, page: "loaded" });
    });

    it("gives no address when the tab cannot be read", async () => {
      const { act, finish, fake, tab, timers } = await started();
      const { after } = await act(WATCHED, () => begin(fake, tab.id, NEXT));
      timers.setTimeout(() => {
        land(fake, tab.id, NEXT);
        fake.browser.tabs.get = () => Promise.reject(new Error("No tab."));
      }, 100);
      assert.deepEqual((await finish(after)).value, { element: BUTTON, page: "loaded" });
    });

    it("waits for the navigation first when a poll fails while one begins, polling once", async () => {
      const { act, finish, fake, tab, timers, answerWith, polls } = await started();
      answerWith(async () => {
        begin(fake, tab.id, NEXT);
        throw new ToolError("page_loading", "Loading.");
      });
      const { after } = await act();
      timers.setTimeout(() => land(fake, tab.id, NEXT), 300);
      assert.deepEqual((await finish(after)).value, {
        element: BUTTON,
        page: "loaded",
        url: NEXT,
      });
      assert.equal(polls.length, 1);
    });

    it("reports loaded when the page refuses the poll after its navigation, polling once", async () => {
      const { act, finish, fake, tab, answerWith, polls } = await started();
      answerWith(() => Promise.reject(new ToolError("site_not_approved", "No.")));
      const { after } = await act(WATCHED, () => {
        begin(fake, tab.id, `${OTHER}/`);
        show(fake, tab.id, `${OTHER}/`);
        fake.emitStatus(tab.id, "complete");
      });
      assert.deepEqual((await finish(after)).value, {
        element: BUTTON,
        page: "loaded",
        url: OTHER,
      });
      assert.equal(polls.length, 1);
    });

    it("lets the navigation decide when the reply carries no watch", async () => {
      const { act, finish, fake, tab, timers, polls } = await started();
      const { after } = await act({ element: BUTTON }, () => begin(fake, tab.id, NEXT));
      timers.setTimeout(() => land(fake, tab.id, NEXT), 100);
      assert.deepEqual((await finish(after)).value, {
        element: BUTTON,
        page: "loaded",
        url: NEXT,
      });
      assert.deepEqual(polls, []);
    });
  });

  describe("tabs that opened", () => {
    it("reports a tab that joined the session's group during the act, not one outside it", async () => {
      const { act, finish, fake, groups } = await started();
      let joined: FakeTab | undefined;
      const { after } = await act(WATCHED, () => {
        joined = fake.openTab();
        void groups.ensureGroup("s1", joined);
        fake.openTab();
      });
      const { value } = await finish(after);
      assert.deepEqual(value, { element: BUTTON, page: "unchanged", openedTabs: [joined?.id] });
    });

    it("lists the group's tabs synchronously when the act is sent", async () => {
      const { settle, fake, tab } = await started();
      const queries: unknown[] = [];
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = (info) => {
        queries.push(info);
        return query(info);
      };
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      assert.deepEqual(queries, [{ groupId: tab.groupId }]);
      watch.stop();
    });

    it("leaves openedTabs out when the group was not known when the act was sent", async () => {
      const { settle, fake, finish, groups, tab } = await started();
      const watch = settle.begin("s1", tab.id, 0);
      watch.sent();
      void groups.ensureGroup("s1", fake.openTab());
      const { value } = await finish(watch.after(WATCHED));
      watch.stop();
      assert.deepEqual(value, { element: BUTTON, page: "unchanged" });
    });

    it("leaves openedTabs out when the group's tabs cannot be listed", async () => {
      for (const failing of ["throws", "rejects", "rejects later"]) {
        const { act, finish, fake, groups } = await started();
        let queries = 0;
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = (info) => {
          queries += 1;
          if (failing === "throws") throw new Error("No.");
          if (failing === "rejects" || queries > 1) return Promise.reject(new Error("No."));
          return query(info);
        };
        const { after } = await act(WATCHED, () => {
          void groups.ensureGroup("s1", fake.openTab());
        });
        const { value } = await finish(after);
        assert.deepEqual(value, { element: BUTTON, page: "unchanged" }, failing);
      }
    });
  });

  describe("files the guard refused", () => {
    it("lists what was refused in the tab since the act was sent", async () => {
      const { act, finish, refused, refusedAsks, sentAt, tab } = await started();
      refused.set(tab.id, [OTHER, "https://c.example"]);
      const { after } = await act();
      const { value } = await finish(after);
      assert.deepEqual(value, {
        element: BUTTON,
        page: "unchanged",
        refusedFiles: [OTHER, "https://c.example"],
      });
      assert.deepEqual(refusedAsks, [{ tabId: tab.id, since: sentAt() }]);
    });

    it("leaves refusedFiles out when nothing was refused", async () => {
      const { act, finish, refusedAsks, tab } = await started();
      const { after } = await act();
      const { value } = await finish(after);
      assert.equal("refusedFiles" in value, false);
      assert.deepEqual(
        refusedAsks.map((ask) => ask.tabId),
        [tab.id],
      );
    });

    it("lists what was refused in a tab the act opened, each site once", async () => {
      const { act, finish, fake, groups, refused, refusedAsks, sentAt, tab } = await started();
      const outside = fake.openTab();
      refused.set(outside.id, ["https://d.example"]);
      let joined: FakeTab | undefined;
      const { after } = await act(WATCHED, () => {
        joined = fake.openTab();
        void groups.ensureGroup("s1", joined);
        refused.set(tab.id, [OTHER]);
        refused.set(joined.id, ["https://c.example", OTHER]);
      });
      const { value } = await finish(after);
      assert.ok(joined !== undefined);
      assert.deepEqual(value, {
        element: BUTTON,
        page: "unchanged",
        openedTabs: [joined.id],
        refusedFiles: [OTHER, "https://c.example"],
      });
      assert.deepEqual(refusedAsks, [
        { tabId: tab.id, since: sentAt() },
        { tabId: joined.id, since: sentAt() },
      ]);
    });

    it("lists no more sites than the guard keeps for one tab", async () => {
      const { act, finish, fake, groups, refused, tab } = await started();
      const sites = Array.from(
        { length: MAX_REFUSALS + 5 },
        (_, index) => `https://s${index}.example`,
      );
      const { after } = await act(WATCHED, () => {
        const joined = fake.openTab();
        void groups.ensureGroup("s1", joined);
        refused.set(tab.id, sites.slice(0, MAX_REFUSALS));
        refused.set(joined.id, sites.slice(MAX_REFUSALS));
      });
      const { value } = await finish(after);
      assert.deepEqual(value.refusedFiles, sites.slice(0, MAX_REFUSALS));
    });

    it("lists what was refused in the tab when the deadline passed", async () => {
      const { settle, tab, timers, refused } = await started();
      refused.set(tab.id, [OTHER]);
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      timers.advance(PAGE_REQUEST_MS);
      assert.deepEqual(await watch.after(WATCHED), {
        element: BUTTON,
        page: "unknown",
        refusedFiles: [OTHER],
      });
      watch.stop();
    });
  });

  describe("bounds", () => {
    it("answers at once when the deadline passed during the act's page request", async () => {
      const { settle, tab, timers, polls } = await started();
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      timers.advance(PAGE_REQUEST_MS);
      const after = watch.after(WATCHED);
      const done = track(after);
      await flush();
      assert.equal(done(), true);
      assert.deepEqual(await after, { element: BUTTON, page: "unknown" });
      assert.deepEqual(polls, []);
      watch.stop();
    });

    it("answers with what it knows when the deadline passes during the settle", async () => {
      const { settle, fake, finish, tab, timers, waits } = await started();
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      begin(fake, tab.id, NEXT);
      timers.advance(PAGE_REQUEST_MS - 1000);
      const { value, elapsed } = await finish(watch.after(WATCHED));
      watch.stop();
      assert.deepEqual(value, { element: BUTTON, page: "loading" });
      assert.equal(elapsed, 1000);
      assert.deepEqual(waits, [NAVIGATION_WAIT_MS]);
    });

    it("answers the last poll's outcome when the deadline passes during the quiet wait", async () => {
      const { settle, finish, page, tab, timers } = await started();
      page.restless = true;
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      timers.advance(PAGE_REQUEST_MS - 500);
      const { value, elapsed } = await finish(watch.after(WATCHED));
      watch.stop();
      assert.deepEqual(value, { element: BUTTON, page: "unsettled" });
      assert.equal(elapsed, 500);
    });

    it("looks up no address once the deadline passed", async () => {
      const { settle, fake, finish, tab, timers } = await started();
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      begin(fake, tab.id, NEXT);
      timers.advance(PAGE_REQUEST_MS - 100);
      const gets: number[] = [];
      const get = fake.browser.tabs.get;
      fake.browser.tabs.get = (tabId) => {
        gets.push(tabId);
        return get(tabId);
      };
      const after = watch.after(WATCHED);
      await flush();
      land(fake, tab.id, NEXT);
      // The tab is read only after the deadline, which the lookup does not wait out.
      fake.browser.tabs.get = (tabId) => {
        gets.push(tabId);
        timers.advance(100);
        return get(tabId);
      };
      const { value } = await finish(after);
      watch.stop();
      assert.deepEqual(value, { element: BUTTON, page: "loaded" });
    });

    it("sends no poll once the deadline passed while it waited for the navigation", async () => {
      const { settle, fake, finish, tab, timers, polls } = await started();
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      begin(fake, tab.id, NEXT);
      timers.advance(PAGE_REQUEST_MS - 100);
      // The navigation ends without a page in the same clock step as the deadline, just before it.
      timers.setTimeout(() => fake.emitStatus(tab.id, "complete"), 100 - 1);
      const after = watch.after(WATCHED);
      await flush();
      timers.advance(100);
      const { value } = await finish(after);
      watch.stop();
      assert.deepEqual(value, { element: BUTTON, page: "loading" });
      assert.deepEqual(polls, []);
    });

    it("leaves no timer behind when the settle ends at once", async () => {
      const { settle, page, tab, timers } = await started();
      page.state = "superseded";
      const before = timers.pending();
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      assert.deepEqual(await watch.after(WATCHED), { element: BUTTON, page: "unknown" });
      // Only the deadline, which stop clears.
      assert.equal(timers.pending(), before + 1);
      watch.stop();
      assert.equal(timers.pending(), before);
    });

    it("leaves no timer of its own behind, after the settle and after stop", async () => {
      const { settle, tab, timers, finish } = await started();
      const before = timers.pending();
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      await finish(watch.after(WATCHED));
      // Only the deadline, which stop clears.
      assert.equal(timers.pending(), before + 1);
      watch.stop();
      assert.equal(timers.pending(), before);
    });

    it("clears every timer when stopped during the settle", async () => {
      const { settle, tab, timers } = await started();
      const before = timers.pending();
      const watch = settle.begin("s1", tab.id, 0);
      await flush();
      watch.sent();
      void watch.after(WATCHED);
      await flush();
      assert.ok(timers.pending() > before + 1);
      watch.stop();
      assert.equal(timers.pending(), before);
    });

    it("answers unknown, without polling, for an act that was never sent", async () => {
      const { settle, tab, polls } = await started();
      const watch = settle.begin("s1", tab.id, 0);
      assert.deepEqual(await watch.after(WATCHED), { element: BUTTON, page: "unknown" });
      watch.stop();
      assert.deepEqual(polls, []);
    });
  });

  describe("the reply's element and watch", () => {
    it("keeps an element with a role read_page shows and a name within its cut", async () => {
      const name = "n".repeat(MAX_FIELD_CHARS + 1);
      for (const element of [
        { role: "generic", name: "" },
        { role: "textbox", name },
      ]) {
        const { act, finish } = await started();
        const { after } = await act({ watch: "w.1", element });
        assert.deepEqual((await finish(after)).value, { element, page: "unchanged" });
      }
    });

    it("leaves out an element it cannot check", async () => {
      for (const element of [
        undefined,
        "button",
        { role: "button" },
        { name: "Save" },
        { role: "banana", name: "Save" },
        { role: "button", name: 1 },
        { role: "button", name: "n".repeat(MAX_FIELD_CHARS + 2) },
        Object.create({ role: "button", name: "Save" }),
      ]) {
        const { act, finish } = await started();
        const { after } = await act({ watch: "w.1", element });
        assert.deepEqual((await finish(after)).value, { page: "unchanged" });
      }
      const { act, finish } = await started();
      const { after } = await act(Object.create({ watch: "w.1", element: BUTTON }));
      assert.deepEqual((await finish(after)).value, { page: "unknown" });
    });

    it("polls only with a watch that is a string of at most 64 characters", async () => {
      const longest = "w".repeat(64);
      const { act, finish, polls } = await started();
      const { after } = await act({ watch: longest });
      assert.deepEqual((await finish(after)).value, { page: "unchanged" });
      assert.equal(polls[0]?.params.watch, longest);
      for (const watch of [`${longest}w`, 1, null, ["w"], { watch: "w" }]) {
        const each = await started();
        const { after: unwatched } = await each.act({ watch });
        assert.deepEqual((await each.finish(unwatched)).value, { page: "unknown" });
        assert.deepEqual(each.polls, []);
      }
      for (const reply of [null, "w.1", ["w.1"]]) {
        const each = await started();
        const { after: unwatched } = await each.act(reply);
        assert.deepEqual((await each.finish(unwatched)).value, { page: "unknown" });
      }
    });
  });
});

interface Poll {
  session: string;
  tabId: number;
  type: string;
  params: Record<string, unknown>;
}

/** A settle on a tab in s1's group on SITE, with a page that answers its polls. */
async function started() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const access = createSiteAccess({ browser: fake.browser, groups, sessions: new Map(), timers });
  const tracker = createTabNavigations({ browser: fake.browser, timers });
  const waits: number[] = [];
  const navigations = {
    begun: (tabId: number) => tracker.begun(tabId),
    settled: (tabId: number, ms: number) => {
      waits.push(ms);
      return tracker.settled(tabId, ms);
    },
  };
  // The act's watch in the page, on the timers' clock: `restless` changes it at every poll,
  // and `quietMs` fixes the answer.
  const page = {
    state: "current",
    changes: 0,
    lastChange: 0,
    restless: false,
    quietMs: undefined as number | undefined,
    change() {
      page.changes += 1;
      page.lastChange = timers.now();
    },
  };
  const polls: Poll[] = [];
  const generations: number[] = [];
  let answer = async (): Promise<unknown> => {
    if (page.state !== "current") return { state: page.state };
    if (page.restless) page.change();
    const quietMs = page.quietMs ?? timers.now() - page.lastChange;
    return { state: "current", changes: page.changes, quietMs };
  };
  const pages = {
    request: async (
      session: string,
      tabId: number,
      type: string,
      params: Record<string, unknown>,
      generation: number,
    ) => {
      polls.push({ session, tabId, type, params });
      generations.push(generation);
      return answer();
    },
  };
  const network = {
    begun: 0,
    open: 0,
    lastEnd: undefined as number | undefined,
    lastFetchEnd: undefined as number | undefined,
    sinces: [] as number[],
  };
  const epoch = 1_000_000;
  let sent = Number.NaN;
  // What the file guard refused in each tab, and what the settle asked it.
  const refused = new Map<number, string[]>();
  const refusedAsks: { tabId: number; since: number }[] = [];
  const settle = createActSettle({
    browser: fake.browser,
    groups,
    access,
    timers,
    navigations,
    files: {
      refusedSince: (tabId: number, since: number) => {
        refusedAsks.push({ tabId, since });
        return refused.get(tabId) ?? [];
      },
    },
    network: {
      requestsSince: (_tabId: number, since: number) => {
        network.sinces.push(since);
        const { begun, open, lastEnd, lastFetchEnd } = network;
        const counts: RequestCounts = { begun, open };
        if (lastEnd !== undefined) counts.lastEnd = lastEnd;
        if (lastFetchEnd !== undefined) counts.lastFetchEnd = lastFetchEnd;
        return counts;
      },
    },
    pages,
    now: () => epoch + timers.now(),
  });
  await grantSite(fake.browser, SITE);
  const opened = fake.openTab();
  await groups.ensureGroup("s1", opened);
  fake.navigateByUser(opened.id, `${SITE}/`);
  await flush();
  const tab = fake.tabs.get(opened.id) ?? opened;

  /** Begins a watch, sends the act, runs `during` as the page acts, and gets the reply. */
  async function act(reply: unknown = WATCHED, during?: () => void, generation = 0) {
    const watch = settle.begin("s1", tab.id, generation);
    // The session's group resolves.
    await flush();
    watch.sent();
    sent = epoch + timers.now();
    page.lastChange = timers.now();
    during?.();
    return { watch, after: watch.after(reply) };
  }

  /** Runs the clock in STEP ms steps until the settle answers; its answer and the time it took. */
  async function finish(after: Promise<ActAfter>): Promise<{ value: ActAfter; elapsed: number }> {
    const done = track(after);
    const start = timers.now();
    await flush();
    while (!done() && timers.now() - start < PAGE_REQUEST_MS) {
      timers.advance(STEP);
      await flush();
    }
    assert.equal(done(), true, "the settle answered");
    return { value: await after, elapsed: timers.now() - start };
  }

  return {
    fake,
    timers,
    groups,
    settle,
    tab,
    page,
    polls,
    generations,
    waits,
    network,
    refused,
    refusedAsks,
    act,
    finish,
    sentAt: () => sent,
    answerWith: (next: () => Promise<unknown>) => {
      answer = next;
    },
  };
}

/** The page's one fetch answers `ms` after the act. */
function answerAt(
  ms: number,
  network: { open: number; lastEnd: number | undefined; lastFetchEnd: number | undefined },
  timers: FakeTimers,
  sentAt: () => number,
): void {
  timers.setTimeout(() => {
    network.open = 0;
    network.lastEnd = sentAt() + ms;
    network.lastFetchEnd = sentAt() + ms;
  }, ms);
}

function track(promise: Promise<unknown>): () => boolean {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return () => done;
}

type Fake = ReturnType<typeof createFakeBrowser>;

/** Firefox begins a navigation of the tab's top frame; the tab still shows its page. */
function begin(fake: Fake, tabId: number, url: string): void {
  fake.emitBeforeNavigate({ tabId, frameId: 0, url });
  if (fake.tabs.has(tabId)) fake.emitStatus(tabId, "loading");
}

/** The navigation's document commits and is still parsing. */
function commit(fake: Fake, tabId: number, url: string): void {
  show(fake, tabId, url);
  fake.emitCommitted({ tabId, frameId: 0, url });
}

/** The tab shows `url`, as after a commit or a page from the back-forward cache. */
function show(fake: Fake, tabId: number, url: string): void {
  const shown = fake.tabs.get(tabId);
  if (shown !== undefined) shown.url = url;
}

/** The navigation's document commits and is parsed. */
function land(fake: Fake, tabId: number, url: string): void {
  commit(fake, tabId, url);
  fake.emitDOMContentLoaded({ tabId, frameId: 0, url });
}
