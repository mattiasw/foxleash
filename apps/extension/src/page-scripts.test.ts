import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { MethodName, TabInfo } from "@foxleash/protocol";
import { createActSettle } from "./act-settle.ts";
import { documentTag, MAX_TAG_NUMBER } from "./element-refs.ts";
import {
  type ContentScript,
  createFakeBrowser,
  createFakeTimers,
  flush,
  type TabMessage,
} from "./fake-browser.ts";
import { createFileGuard } from "./file-guard.ts";
import { createHandlers, NAVIGATION_WAIT_MS, ToolError } from "./handlers.ts";
import { createLoadHops } from "./load-hops.ts";
import {
  handlePageMessage,
  MAX_PAGE_REPLY_CHARS,
  PageError,
  type PageHandlers,
} from "./page-messages.ts";
import {
  CONTENT_SCRIPT,
  createPageScripts,
  PAGE_INJECTION_MS,
  PAGE_REPLY_MS,
  PAGE_REQUEST_MS,
  parsePageReply,
  TAG_BLOCK,
  TAG_RESERVE_MS,
} from "./page-scripts.ts";
import { createPageViews } from "./page-view.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite, TAG_MARK_KEY } from "./settings.ts";
import { createSiteAccess, type OpenPrompt, type SessionMemory } from "./site-access.ts";
import { createTabNavigations } from "./tab-navigations.ts";
import { createUploads } from "./uploads.ts";

const SITE = "https://a.example";

describe("page script requests", { timeout: 10000 }, () => {
  it("refuses a tab that does not exist", async () => {
    const { fake, pages, open } = setup();
    await open("s1");
    await assert.rejects(pages.request("s1", 99, "echo", {}, 0), {
      code: "tab_not_found",
      message: "Tab 99 does not exist.",
    });
    assertNothingSent(fake);
  });

  it("refuses a tab outside the session's group, on an allowed site", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    await open("s1", `${SITE}/`);
    await open("s2", `${SITE}/`);
    const outside = fake.openTab({ url: `${SITE}/` });
    const inS1 = [...fake.tabs.values()].find((tab) => tab.id !== outside.id)?.id ?? -1;
    for (const [session, tabId] of [
      ["s1", outside.id],
      ["s2", inS1],
      ["s3", inS1],
    ] as const) {
      await assert.rejects(pages.request(session, tabId, "echo", {}, 0), {
        code: "tab_not_in_group",
        message: `Tab ${tabId} is not in this session's tab group; open a tab with tab_open first.`,
      });
    }
    assertNothingSent(fake);
  });

  it("refuses the tab that shows the session's open prompt", async () => {
    const { fake, pages, call, promptOf } = setup();
    const opened = call("s1", "tab_open", { url: `${SITE}/` });
    const prompt = await promptOf("s1");
    await assert.rejects(pages.request("s1", prompt.tabId, "echo", {}, 0), {
      code: "approval_pending",
      message: `Foxleash is waiting for the user to answer whether to allow ${SITE} in the tab titled "Foxleash" in the user's Firefox window (tab id ${prompt.tabId}). Try again after the user has answered.`,
    });
    assertNothingSent(fake);
    void opened.catch(() => {});
  });

  it("refuses a tab that is not on a web page, the prompt page included", async () => {
    const { fake, pages, open } = setup();
    const tab = await open("s1");
    const promptUrl = fake.browser.runtime.getURL(`approve.html?site=${SITE}`);
    for (const url of ["about:blank", promptUrl, "file:///home/x.html"]) {
      fake.navigateByUser(tab.id, url);
      await flush();
      await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
        code: "page_not_web",
        message: `Foxleash acts only on http and https pages, and tab ${tab.id} shows another kind of page.`,
      });
    }
    assertNothingSent(fake);
  });

  it("refuses a blocklisted site, also when the user granted it", async () => {
    const { fake, pages, open, grant } = setup();
    const tab = await open("s1");
    fake.navigateByUser(tab.id, "https://www.paypal.com/");
    await flush();
    const blocked = {
      code: "site_blocked",
      message:
        "Foxleash does not act on https://www.paypal.com: it is on Foxleash's blocklist, which by default lists common financial and health sites.",
    };
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), blocked);
    await grant("https://www.paypal.com");
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), blocked);
    assertNothingSent(fake);
  });

  it("refuses a site the session may not act on, without asking", async () => {
    const { fake, pages, open, access } = setup();
    const tab = await open("s1");
    fake.navigateByUser(tab.id, `${SITE}/x`);
    await flush();
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
      code: "site_not_approved",
      message: `Foxleash is not allowed on ${SITE} in this session; call navigate with tab ${tab.id} and action reload to ask the user.`,
    });
    await flush();
    assert.equal(access.openPrompt("s1"), undefined);
    assert.equal(fake.tabs.get(tab.id)?.url, `${SITE}/x`);
    assertNothingSent(fake);
  });

  it("injects the content script into the top frame, then asks it with the checked site", async () => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/page`);
    const timersBefore = timers.pending();
    const seen: unknown[] = [];
    fake.setContentScript(tab.id, async (message) => {
      seen.push(message);
      return { ok: true, site: SITE, result: { answer: 42 } };
    });
    const params = { text: "hi" };
    assert.deepEqual(await pages.request("s1", tab.id, "echo", params, 0), { answer: 42 });
    assert.deepEqual(fake.injections, [
      { tabId: tab.id, frameIds: [0], files: [CONTENT_SCRIPT], injectImmediately: true },
    ]);
    const message = { kind: "foxleash-page", type: "echo", site: SITE, tag: "a", params };
    assert.deepEqual(fake.tabMessages, [{ tabId: tab.id, message, frameId: 0 }]);
    assert.deepEqual(seen, [message]);
    assert.equal(timers.pending(), timersBefore);
    assert.equal(CONTENT_SCRIPT, "content.js");
  });

  it("injects on every request", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, async () => ({ ok: true, site: SITE, result: 1 }));
    await pages.request("s1", tab.id, "echo", {}, 0);
    await pages.request("s1", tab.id, "echo", {}, 0);
    assert.equal(fake.injections.length, 2);
    assert.equal(fake.tabMessages.length, 2);
  });

  it("does not call onSend for a request refused before its message is sent", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    await open("s1", `${SITE}/`);
    const outside = fake.openTab({ url: `${SITE}/` });
    const approvedNot = await open("s1");
    fake.navigateByUser(approvedNot.id, "https://c.example/");
    await flush();
    let sends = 0;
    const onSend = () => {
      sends += 1;
    };
    await rejectsWith(pages.request("s1", outside.id, "click", {}, 0, onSend), "tab_not_in_group");
    await rejectsWith(
      pages.request("s1", approvedNot.id, "click", {}, 0, onSend),
      "site_not_approved",
    );
    assert.equal(sends, 0);
    assertNothingSent(fake);
  });

  it("acts on a site the session allowed only for itself", async () => {
    const { fake, pages, open, sessions } = setup();
    const tab = await open("s1");
    fake.navigateByUser(tab.id, `${SITE}/`);
    await flush();
    sessions.set("s1", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
    fake.setContentScript(tab.id, contentScript(SITE));
    assert.deepEqual(await pages.request("s1", tab.id, "echo", { a: 1 }, 0), { echoed: { a: 1 } });
  });

  it("round-trips through the content script's dispatcher, its errors included", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, contentScript(SITE));
    assert.deepEqual(await pages.request("s1", tab.id, "echo", { a: [1, "b"] }, 0), {
      echoed: { a: [1, "b"] },
    });
    await assert.rejects(pages.request("s1", tab.id, "stale", {}, 0), {
      code: "stale_ref",
      message: "Element x-1 is from a page the tab no longer shows.",
    });
    await assert.rejects(pages.request("s1", tab.id, "secret", {}, 0), {
      code: "page_error",
      message: `Foxleash could not complete the request in the page in tab ${tab.id}.`,
    });
    await assert.rejects(pages.request("s1", tab.id, "toString", {}, 0), {
      code: "invalid_params",
      message: "Foxleash's page script has no request of that type.",
    });
  });

  it("is refused by a content script whose document is on another site", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    const calls: unknown[] = [];
    const handlers: PageHandlers = { echo: (params) => calls.push(params) };
    for (const site of ["https://b.example", undefined]) {
      fake.setContentScript(tab.id, (message) =>
        handlePageMessage(message, { site, handlers, adopt: noop, before: noop }),
      );
      await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
        code: "page_changed",
        message: `The page in tab ${tab.id} changed while Foxleash was working in it; try again.`,
      });
    }
    assert.deepEqual(calls, []);
  });

  const withdrawals: Change[] = [
    { name: "ungrouped", code: "tab_not_in_group", change: ({ fake }, id) => fake.ungroup(id) },
    {
      name: "blocklisted",
      code: "site_blocked",
      change: ({ fake }) => fake.browser.storage.local.set({ blocklist: ["a.example"] }),
    },
    {
      name: "revoked",
      code: "site_not_approved",
      change: ({ fake }) => revokeSite(fake.browser, SITE),
    },
  ];

  describe("checks the tab again after the injection", () => {
    const changes: Change[] = [
      ...withdrawals,
      {
        name: "navigated to another allowed site",
        code: "page_changed",
        change: ({ fake }, id) => fake.navigateByUser(id, "https://b.example/"),
      },
      {
        name: "navigated to a page that is not a website",
        code: "page_not_web",
        change: ({ fake }, id) => fake.navigateByUser(id, "about:blank"),
      },
      {
        name: "closed",
        code: "tab_not_found",
        change: ({ fake }, id) => fake.removeTab(id),
      },
    ];
    for (const { name, code, change } of changes) {
      it(`refuses a tab ${name} meanwhile, sending nothing`, async (t) => {
        const env = await grantedTab();
        const { fake, pages, tab } = env;
        t.mock.method(fake.browser.scripting, "executeScript", async () => {
          await change(env, tab.id);
          await flush();
          return [{ frameId: 0, result: null }];
        });
        await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), code);
        assert.deepEqual(fake.tabMessages, []);
      });
    }

    it("refuses a site the session forgot meanwhile, sending nothing", async (t) => {
      const { fake, pages, access, tab } = await sessionAllowedTab();
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        access.forget("s1", SITE);
        return [{ frameId: 0, result: null }];
      });
      await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "site_not_approved");
      assert.deepEqual(fake.tabMessages, []);
    });
  });

  describe("checks the tab again after the answer", () => {
    for (const { name, code, change } of withdrawals) {
      it(`refuses the answer from a tab ${name} meanwhile`, async () => {
        const env = await grantedTab();
        const { fake, pages, tab } = env;
        fake.setContentScript(tab.id, async () => {
          await change(env, tab.id);
          await flush();
          return { ok: true, site: SITE, result: "page text" };
        });
        await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), code);
        assert.equal(fake.tabMessages.length, 1);
      });
    }

    it("refuses the answer from a site the session forgot meanwhile", async () => {
      const { fake, pages, access, tab } = await sessionAllowedTab();
      fake.setContentScript(tab.id, async () => {
        access.forget("s1", SITE);
        return { ok: true, site: SITE, result: "page text" };
      });
      await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "site_not_approved");
    });

    it("refuses the answer from a tab that shows another allowed site by then", async () => {
      const { fake, pages, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        // The old document answers while the tab already reports its next URL.
        const shown = fake.tabs.get(tab.id);
        if (shown !== undefined) shown.url = "https://b.example/";
        return { ok: true, site: SITE, result: "page text" };
      });
      await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "page_changed");
    });
  });

  /** A tab in s1's group on SITE, which the user allowed always, and on b.example too. */
  async function grantedTab(): Promise<Env & { tab: TabInfo }> {
    const env = setup();
    await env.grant(SITE);
    await env.grant("https://b.example");
    const tab = await env.open("s1", `${SITE}/`);
    env.fake.setContentScript(tab.id, contentScript(SITE));
    return { ...env, tab };
  }

  /** A tab in s1's group on SITE, which only the session allowed. */
  async function sessionAllowedTab(): Promise<Env & { tab: TabInfo }> {
    const env = setup();
    const tab = await env.open("s1");
    env.fake.navigateByUser(tab.id, `${SITE}/`);
    await flush();
    env.sessions.set("s1", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
    env.fake.setContentScript(tab.id, contentScript(SITE));
    return { ...env, tab };
  }

  it("refuses when Firefox refuses the injection, without its error text", async () => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/secret-path`);
    const timersBefore = timers.pending();
    fake.failNextInjection(new Error(`Missing host permission for ${SITE}/secret-path`));
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
      code: "page_unreachable",
      message: `Firefox did not let Foxleash into the page in tab ${tab.id}.`,
    });
    assert.equal(fake.injections.length, 1);
    assert.deepEqual(fake.tabMessages, []);
    assert.equal(timers.pending(), timersBefore);
  });

  it("refuses when executeScript throws instead of rejecting", async (t) => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    t.mock.method(fake.browser.scripting, "executeScript", () => {
      throw new Error(`Bad target ${SITE}/`);
    });
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
      code: "page_unreachable",
      message: `Firefox did not let Foxleash into the page in tab ${tab.id}.`,
    });
    assert.deepEqual(fake.tabMessages, []);
  });

  it("says Firefox withholds the site when it refuses the injection without the site's access", async () => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/secret-path`);
    const timersBefore = timers.pending();
    fake.allUrls = false;
    fake.failNextInjection(new Error(`Missing host permission for ${SITE}/secret-path`));
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
      code: "site_access_withheld",
      message: `Firefox has not given Foxleash access to this site, so Foxleash cannot read or act in the page in tab ${tab.id}. Ask the user to open about:addons in Firefox, click Foxleash, then the Permissions tab, and under "Optional" turn on "Access your data for all websites". Firefox lists this access as optional, but Foxleash needs it.`,
    });
    assert.deepEqual(fake.permissionChecks, [[`${SITE}/*`]]);
    assert.deepEqual(fake.tabMessages, []);
    assert.equal(timers.pending(), timersBefore);
  });

  it("refuses as unreachable when Firefox gave the site's access but refused the injection", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.allUrls = false;
    fake.grantedOrigins.add(`${SITE}/*`);
    fake.failNextInjection(new Error("boom"));
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
      code: "page_unreachable",
      message: `Firefox did not let Foxleash into the page in tab ${tab.id}.`,
    });
    assert.deepEqual(fake.tabMessages, []);
  });

  it("asks for the site's access without its port", async () => {
    const { fake, pages, open, grant } = setup();
    await grant("https://a.example:8443");
    const tab = await open("s1", "https://a.example:8443/");
    fake.allUrls = false;
    fake.failNextInjection(new Error("boom"));
    await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "site_access_withheld");
    assert.deepEqual(fake.permissionChecks, [["https://a.example/*"]]);
    assert.deepEqual(fake.tabMessages, []);
  });

  it("refuses as unreachable when Firefox does not answer whether it gave the site's access", async (t) => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.allUrls = false;
    fake.failNextInjection(new Error("boom"));
    t.mock.method(fake.browser.permissions, "contains", () =>
      Promise.reject(new Error("no answer")),
    );
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
      code: "page_unreachable",
      message: `Firefox did not let Foxleash into the page in tab ${tab.id}.`,
    });
    assert.deepEqual(fake.tabMessages, []);
  });

  it("times out a refused injection whose access check never settles, sending nothing", async (t) => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    const timersBefore = timers.pending();
    fake.allUrls = false;
    fake.failNextInjection(new Error("boom"));
    t.mock.method(fake.browser.permissions, "contains", () => new Promise(() => {}));
    const { request, settled } = track(pages.request("s1", tab.id, "echo", {}, 0));
    await flush();
    timers.advance(PAGE_INJECTION_MS - 1);
    await flush();
    assert.equal(settled(), false);
    timers.advance(1);
    await assert.rejects(request, {
      code: "page_timeout",
      message: `Foxleash could not get into the page in tab ${tab.id} in time; try again.`,
    });
    assert.deepEqual(fake.tabMessages, []);
    assert.equal(timers.pending(), timersBefore);
  });

  const failures: { name: string; frames: { frameId: number; error?: unknown }[] }[] = [
    { name: "an error in frame 0", frames: [{ frameId: 0, error: new Error("boom") }] },
    { name: "an error that is null", frames: [{ frameId: 0, error: null }] },
    { name: "no frame 0", frames: [{ frameId: 2 }] },
    { name: "no frames", frames: [] },
  ];
  for (const { name, frames } of failures) {
    it(`refuses an injection with ${name}`, async () => {
      const { fake, pages, open, grant } = setup();
      await grant(SITE);
      const tab = await open("s1", `${SITE}/`);
      fake.setContentScript(tab.id, contentScript(SITE));
      fake.injectionResults = frames;
      await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "page_unreachable", name);
      assert.deepEqual(fake.tabMessages, []);
    });
  }
  for (const { name, frames } of failures) {
    it(`says Firefox withholds the site for an injection with ${name} without the site's access`, async () => {
      const { fake, pages, open, grant } = setup();
      await grant(SITE);
      const tab = await open("s1", `${SITE}/`);
      fake.setContentScript(tab.id, contentScript(SITE));
      fake.allUrls = false;
      fake.injectionResults = frames;
      await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "site_access_withheld", name);
      assert.deepEqual(fake.tabMessages, []);
    });
  }

  it("takes frame 0 among others, with or without a result", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, contentScript(SITE));
    fake.injectionResults = [{ frameId: 3, error: new Error("boom") }, { frameId: 0 }];
    assert.deepEqual(await pages.request("s1", tab.id, "echo", {}, 0), { echoed: {} });
  });

  it("times out an injection that never settles, sending nothing", async (t) => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    const timersBefore = timers.pending();
    fake.setContentScript(tab.id, contentScript(SITE));
    t.mock.method(fake.browser.scripting, "executeScript", () => new Promise(() => {}));
    const { request, settled } = track(pages.request("s1", tab.id, "echo", {}, 0));
    await flush();
    timers.advance(PAGE_INJECTION_MS - 1);
    await flush();
    assert.equal(settled(), false);
    timers.advance(1);
    await assert.rejects(request, {
      code: "page_timeout",
      message: `Foxleash could not get into the page in tab ${tab.id} in time; try again.`,
    });
    assert.deepEqual(fake.tabMessages, []);
    assert.equal(timers.pending(), timersBefore);
  });

  it("times out a content script that never answers", async () => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    const timersBefore = timers.pending();
    fake.setContentScript(tab.id, () => new Promise(() => {}));
    const { request, settled } = track(pages.request("s1", tab.id, "echo", {}, 0));
    await flush();
    assert.equal(fake.tabMessages.length, 1);
    timers.advance(PAGE_REPLY_MS - 1);
    await flush();
    assert.equal(settled(), false);
    timers.advance(1);
    await assert.rejects(request, {
      code: "page_timeout",
      message: `The page in tab ${tab.id} did not answer Foxleash within 10 seconds; try again.`,
    });
    assert.equal(timers.pending(), timersBefore);
  });

  for (const type of ["click", "drag", "type", "press_key", "fill_form", "upload_file"]) {
    it(`says ${type} may already have run when the page does not answer`, async () => {
      const { fake, pages, open, grant, timers } = setup();
      await grant(SITE);
      const tab = await open("s1", `${SITE}/`);
      const timersBefore = timers.pending();
      fake.setContentScript(tab.id, () => new Promise(() => {}));
      const { request, settled } = track(pages.request("s1", tab.id, type, {}, 0));
      await flush();
      assert.equal(fake.tabMessages.length, 1);
      timers.advance(PAGE_REPLY_MS - 1);
      await flush();
      assert.equal(settled(), false);
      timers.advance(1);
      await assert.rejects(request, {
        code: "page_timeout",
        message: `The page in tab ${tab.id} did not answer Foxleash within 10 seconds, but ${type} may already have run; read the page before you repeat it.`,
      });
      assert.equal(timers.pending(), timersBefore);
    });
  }

  for (const type of ["hover", "scroll", "read_page", "wait_for"]) {
    it(`tells ${type} to try again when the page does not answer`, async () => {
      const { fake, pages, open, grant, timers } = setup();
      await grant(SITE);
      const tab = await open("s1", `${SITE}/`);
      const timersBefore = timers.pending();
      fake.setContentScript(tab.id, () => new Promise(() => {}));
      const { request } = track(pages.request("s1", tab.id, type, {}, 0));
      await flush();
      timers.advance(PAGE_REPLY_MS);
      await assert.rejects(request, {
        code: "page_timeout",
        message: `The page in tab ${tab.id} did not answer Foxleash within 10 seconds; try again.`,
      });
      assert.equal(timers.pending(), timersBefore);
    });
  }

  it("bounds both waits below the host's 60 s request timeout, as probe_input does", () => {
    assert.equal(PAGE_INJECTION_MS, 20_000);
    assert.equal(PAGE_REPLY_MS, 10_000);
  });

  it("refuses when no content script answers in the tab", async () => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    const timersBefore = timers.pending();
    await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), {
      code: "page_changed",
      message: `The page in tab ${tab.id} changed while Foxleash was working in it; try again.`,
    });
    assert.equal(fake.tabMessages.length, 1);
    assert.equal(timers.pending(), timersBefore);
  });

  const endings: { name: string; end: (fake: Env["fake"], tabId: number) => void }[] = [
    { name: "navigates", end: (fake, tabId) => fake.navigateByUser(tabId, `${SITE}/next`) },
    { name: "closes", end: (fake, tabId) => fake.removeTab(tabId) },
    {
      name: "closes with its group",
      end: (fake, tabId) => fake.closeGroup(fake.tabs.get(tabId)?.groupId ?? -1),
    },
    {
      name: "loses its content script",
      end: (fake, tabId) => fake.setContentScript(tabId, undefined),
    },
  ];
  for (const { name, end } of endings) {
    it(`refuses at once when the tab ${name} before the answer`, async () => {
      const { fake, pages, open, grant, timers } = setup();
      await grant(SITE);
      const tab = await open("s1", `${SITE}/`);
      const timersBefore = timers.pending();
      fake.setContentScript(tab.id, () => new Promise(() => {}));
      const request = pages.request("s1", tab.id, "echo", {}, 0);
      await flush();
      assert.equal(fake.tabMessages.length, 1);
      end(fake, tab.id);
      await rejectsWith(request, "page_changed");
      assert.equal(timers.pending(), timersBefore);
    });
  }

  it("finds no content script in the tab after a load", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, contentScript(SITE));
    fake.navigateByUser(tab.id, `${SITE}/next`);
    await flush();
    await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "page_changed");
    assert.equal(fake.tabMessages.length, 1);
  });

  it("refuses a reply that cannot be cloned", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, async () => ({ ok: true, site: SITE, result: () => 1 }));
    await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "page_changed");
  });

  it("checks the reply", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, async () => ({ ok: true, site: "https://b.example" }));
    await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "page_changed");
    fake.setContentScript(tab.id, async () => undefined);
    await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "page_error");
  });

  describe("tags each message for the document that takes it", () => {
    const REFUSED = (tabId: number) => ({
      code: "page_error",
      message: `Foxleash could not prepare its request to the page in tab ${tabId}; try again.`,
    });

    it("gives every message its own tag from one counter for every tab", async () => {
      const { fake, pages, open, tab } = await grantedTab();
      const other = await open("s1", `${SITE}/other`);
      fake.setContentScript(other.id, contentScript(SITE));
      await pages.request("s1", other.id, "echo", {}, 0);
      await pages.request("s1", tab.id, "echo", {}, 0);
      await pages.request("s1", other.id, "echo", {}, 0);
      assert.deepEqual(tagsSent(fake), ["a", "b", "c"]);
      assert.deepEqual(
        fake.tabMessages.map((sent) => sent.tabId),
        [other.id, tab.id, other.id],
      );
      assert.equal(TAG_BLOCK, 100);
      assert.equal(await storedMark(fake), TAG_BLOCK);
    });

    it("stores the next mark before it hands out a tag above the stored one", async (t) => {
      const { fake, pages, tab } = await grantedTab();
      const set = fake.browser.storage.local.set;
      const marks: [unknown, number][] = [];
      t.mock.method(fake.browser.storage.local, "set", async (items: Record<string, unknown>) => {
        await set(items);
        if (Object.hasOwn(items, TAG_MARK_KEY)) {
          marks.push([items[TAG_MARK_KEY], fake.tabMessages.length]);
        }
      });
      for (let sent = 0; sent < TAG_BLOCK + 1; sent += 1) {
        await pages.request("s1", tab.id, "echo", {}, 0);
      }
      assert.deepEqual(marks, [
        [TAG_BLOCK, 0],
        [2 * TAG_BLOCK, TAG_BLOCK],
      ]);
      const tags = tagsSent(fake);
      assert.equal(new Set(tags).size, TAG_BLOCK + 1);
      assert.equal(tags.at(-1), documentTag(TAG_BLOCK + 1));
      assert.equal(tags.at(-1), "cw");
    });

    it("hands out tags above the stored mark after a restart", async () => {
      const { fake, pages, tab, restart } = await grantedTab();
      await pages.request("s1", tab.id, "echo", {}, 0);
      const restarted = restart();
      await restarted.request("s1", tab.id, "echo", {}, 0);
      await restarted.request("s1", tab.id, "echo", {}, 0);
      assert.deepEqual(tagsSent(fake), [
        "a",
        documentTag(TAG_BLOCK + 1),
        documentTag(TAG_BLOCK + 2),
      ]);
      assert.equal(await storedMark(fake), 2 * TAG_BLOCK);
    });

    it("reads the stored mark once, and shares one read and one write between first requests", async (t) => {
      const { fake, pages, tab, restart } = await grantedTab();
      const get = t.mock.method(fake.browser.storage.local, "get");
      const set = t.mock.method(fake.browser.storage.local, "set");
      await pages.request("s1", tab.id, "echo", {}, 0);
      const first = get.mock.callCount();
      get.mock.resetCalls();
      await pages.request("s1", tab.id, "echo", {}, 0);
      // The gate reads storage too: what a request reads once the mark is known.
      const gate = get.mock.callCount();
      assert.equal(first, gate + 1);
      get.mock.resetCalls();
      set.mock.resetCalls();
      const restarted = restart();
      const requests = [1, 2, 3].map(() => restarted.request("s1", tab.id, "echo", {}, 0));
      await Promise.all(requests);
      assert.equal(get.mock.callCount(), 3 * gate + 1);
      assert.equal(set.mock.callCount(), 1);
      assert.deepEqual(
        tagsSent(fake).slice(2).sort(),
        [TAG_BLOCK + 1, TAG_BLOCK + 2, TAG_BLOCK + 3].map(documentTag).sort(),
      );
    });

    it("sends nothing until the mark is stored", async (t) => {
      const { fake, pages, tab } = await grantedTab();
      const set = fake.browser.storage.local.set;
      const stored = Promise.withResolvers<void>();
      t.mock.method(fake.browser.storage.local, "set", async (items: Record<string, unknown>) => {
        if (Object.hasOwn(items, TAG_MARK_KEY)) await stored.promise;
        await set(items);
      });
      const request = track(pages.request("s1", tab.id, "echo", {}, 0));
      await flush();
      assert.equal(request.settled(), false);
      assertNothingSent(fake);
      stored.resolve();
      assert.deepEqual(await request.request, { echoed: {} });
      assert.deepEqual(tagsSent(fake), ["a"]);
    });

    it("fails a request whose mark is not stored in time, and goes on once it is", async (t) => {
      const warned = warnings(t);
      const { fake, pages, tab, timers } = await grantedTab();
      const set = fake.browser.storage.local.set;
      const stored = Promise.withResolvers<void>();
      const mock = t.mock.method(
        fake.browser.storage.local,
        "set",
        async (items: Record<string, unknown>) => {
          if (Object.hasOwn(items, TAG_MARK_KEY)) await stored.promise;
          await set(items);
        },
      );
      const timersBefore = timers.pending();
      const first = track(pages.request("s1", tab.id, "echo", {}, 0));
      await flush();
      timers.advance(TAG_RESERVE_MS - 1);
      await flush();
      assert.equal(first.settled(), false);
      timers.advance(1);
      await assert.rejects(first.request, REFUSED(tab.id));
      // A later request waits on the same write, which is not started again.
      const second = track(pages.request("s1", tab.id, "echo", {}, 0));
      await flush();
      timers.advance(TAG_RESERVE_MS);
      await assert.rejects(second.request, REFUSED(tab.id));
      assertNothingSent(fake);
      assert.equal(mock.mock.callCount(), 1);
      stored.resolve();
      await flush();
      assert.deepEqual(await pages.request("s1", tab.id, "echo", {}, 0), { echoed: {} });
      assert.deepEqual(tagsSent(fake), ["a"]);
      assert.equal(timers.pending(), timersBefore);
      assert.deepEqual(warned(), []);
      assert.equal(TAG_RESERVE_MS, 5_000);
    });

    it("waits for its tag at most TAG_RESERVE_MS in all, also over two writes", async (t) => {
      const { fake, pages, tab, timers } = await grantedTab();
      const set = fake.browser.storage.local.set;
      const writes: PromiseWithResolvers<void>[] = [];
      t.mock.method(fake.browser.storage.local, "set", async (items: Record<string, unknown>) => {
        if (Object.hasOwn(items, TAG_MARK_KEY)) {
          const write = Promise.withResolvers<void>();
          writes.push(write);
          await write.promise;
        }
        await set(items);
      });
      const requests = Array.from({ length: TAG_BLOCK + 1 }, () =>
        track(pages.request("s1", tab.id, "echo", {}, 0)),
      );
      for (let turn = 0; turn < 5; turn += 1) await flush();
      assert.equal(writes.length, 1);
      timers.advance(TAG_RESERVE_MS - 1);
      writes[0]?.resolve();
      for (let turn = 0; turn < 20; turn += 1) await flush();
      // The block is used up: the last request waits on the next write.
      assert.equal(writes.length, 2);
      assert.equal(requests.filter((request) => request.settled()).length, TAG_BLOCK);
      const last = requests.at(-1);
      assert.ok(last !== undefined);
      assert.equal(last.settled(), false);
      timers.advance(1);
      await flush();
      assert.equal(last.settled(), true, "the last request is still waiting");
      await assert.rejects(last.request, REFUSED(tab.id));
      assert.equal(new Set(tagsSent(fake)).size, TAG_BLOCK);
      writes[1]?.resolve();
    });

    it("fails a request when the mark cannot be stored, and tries again on the next", async (t) => {
      const warned = warnings(t);
      const { fake, pages, tab, restart } = await grantedTab();
      fake.failNextSet();
      await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), REFUSED(tab.id));
      assertNothingSent(fake);
      assert.equal(await storedMark(fake), undefined);
      assert.deepEqual(await pages.request("s1", tab.id, "echo", {}, 0), { echoed: {} });
      const restarted = restart();
      fake.failNextSet();
      await assert.rejects(restarted.request("s1", tab.id, "echo", {}, 0), REFUSED(tab.id));
      await restarted.request("s1", tab.id, "echo", {}, 0);
      assert.deepEqual(tagsSent(fake), ["a", documentTag(TAG_BLOCK + 1)]);
      assert.deepEqual(warned(), [
        { event: "tag_mark_failed", error: "Error: Storage is full" },
        { event: "tag_mark_failed", error: "Error: Storage is full" },
      ]);
    });

    it("fails a request when the mark cannot be read, and reads it again on the next", async (t) => {
      const warned = warnings(t);
      const { fake, tab, restart } = await grantedTab();
      await fake.browser.storage.local.set({ [TAG_MARK_KEY]: TAG_BLOCK });
      const pages = restart();
      const get = fake.browser.storage.local.get;
      let reads = 0;
      let failAt = 0;
      t.mock.method(fake.browser.storage.local, "get", async (keys: null) => {
        reads += 1;
        if (reads === failAt) throw new Error("Storage is gone");
        return get(keys);
      });
      // The gate's reads in a request once the mark is known.
      const known = restart();
      await known.request("s1", tab.id, "echo", {}, 0);
      const before = reads;
      await known.request("s1", tab.id, "echo", {}, 0);
      // The gate runs before the tag is reserved, after the injection and after the answer.
      const gateReads = (reads - before) / 3;
      assert.ok(Number.isInteger(gateReads) && gateReads > 0);
      failAt = reads + gateReads + 1;
      await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), REFUSED(tab.id));
      assert.equal(reads, failAt);
      await pages.request("s1", tab.id, "echo", {}, 0);
      assert.deepEqual(tagsSent(fake), [
        documentTag(TAG_BLOCK + 1),
        documentTag(TAG_BLOCK + 2),
        documentTag(2 * TAG_BLOCK + 1),
      ]);
      assert.deepEqual(warned(), [{ event: "tag_mark_failed", error: "Error: Storage is gone" }]);
    });

    for (const mark of ["5", -1, 1.5, {}, null, MAX_TAG_NUMBER + 1, Number.NaN]) {
      it(`refuses to hand out tags over the stored mark ${JSON.stringify(mark)}`, async (t) => {
        const warned = warnings(t);
        const { fake, tab, restart } = await grantedTab();
        await fake.browser.storage.local.set({ [TAG_MARK_KEY]: mark });
        const pages = restart();
        await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), REFUSED(tab.id));
        await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), REFUSED(tab.id));
        assertNothingSent(fake);
        assert.deepEqual(warned(), [{ event: "ignored_tag_mark" }, { event: "ignored_tag_mark" }]);
        // Read again on each request, so a repaired mark needs no restart.
        await fake.browser.storage.local.set({ [TAG_MARK_KEY]: 7 });
        await pages.request("s1", tab.id, "echo", {}, 0);
        assert.deepEqual(tagsSent(fake), [documentTag(8)]);
      });
    }

    it("keeps counting from its own mark when the stored one goes down", async () => {
      const { fake, pages, tab } = await grantedTab();
      await pages.request("s1", tab.id, "echo", {}, 0);
      await fake.browser.storage.local.set({ [TAG_MARK_KEY]: 0 });
      for (let sent = 1; sent < TAG_BLOCK + 1; sent += 1) {
        await pages.request("s1", tab.id, "echo", {}, 0);
      }
      const tags = tagsSent(fake);
      assert.equal(new Set(tags).size, TAG_BLOCK + 1);
      assert.equal(tags.at(-1), documentTag(TAG_BLOCK + 1));
      assert.equal(await storedMark(fake), 2 * TAG_BLOCK);
    });

    it("refuses at once when the stored mark is the last tag's", async (t) => {
      const warned = warnings(t);
      const { fake, tab, restart } = await grantedTab();
      await fake.browser.storage.local.set({ [TAG_MARK_KEY]: MAX_TAG_NUMBER });
      await assert.rejects(restart().request("s1", tab.id, "echo", {}, 0), REFUSED(tab.id));
      assertNothingSent(fake);
      assert.deepEqual(warned(), [{ event: "tags_used_up" }]);
    });

    it("hands out the last tag, then refuses", async (t) => {
      const warned = warnings(t);
      const { fake, tab, restart } = await grantedTab();
      await fake.browser.storage.local.set({ [TAG_MARK_KEY]: MAX_TAG_NUMBER - 1 });
      const pages = restart();
      await pages.request("s1", tab.id, "echo", {}, 0);
      assert.equal(await storedMark(fake), MAX_TAG_NUMBER);
      await assert.rejects(pages.request("s1", tab.id, "echo", {}, 0), REFUSED(tab.id));
      assert.deepEqual(tagsSent(fake), ["zzzzzzz"]);
      assert.deepEqual(warned(), [{ event: "tags_used_up" }]);
    });

    it("refuses a tab outside the group before it reserves a tag", async () => {
      const { fake, pages } = await grantedTab();
      const outside = fake.openTab({ url: `${SITE}/` });
      await rejectsWith(pages.request("s1", outside.id, "echo", {}, 0), "tab_not_in_group");
      assert.equal(await storedMark(fake), undefined);
      assertNothingSent(fake);
    });
  });

  describe("waits for a navigation under way", () => {
    const NEXT = `${SITE}/next`;
    const LOADING = {
      code: "page_loading",
      message: (tabId: number) => `Tab ${tabId} is still loading a page; try again.`,
    };
    const ranChanged = (tabId: number, type: string) => ({
      code: "page_changed",
      message: `The page in tab ${tabId} changed after ${type} ran; read the page before you repeat it.`,
    });
    const ranLoading = (tabId: number, type: string) => ({
      code: "page_loading",
      message: `Tab ${tabId} is still loading a page, and ${type} may already have run; read the page before you repeat it.`,
    });

    it("waits, sending nothing, then runs in the page the navigation brings", async () => {
      const { fake, pages, navigations, timers, tab } = await grantedTab();
      const timersBefore = timers.pending();
      assert.equal(navigations.underWay(tab.id), false);
      begin(fake, tab.id, NEXT);
      const { request, settled } = track(pages.request("s1", tab.id, "echo", {}, 0));
      await flush();
      assertNothingSent(fake);
      timers.advance(NAVIGATION_WAIT_MS - 1);
      await flush();
      assert.equal(settled(), false);
      assertNothingSent(fake);
      land(fake, tab.id, NEXT, answering("new page"));
      assert.equal(await request, "new page");
      assert.equal(fake.injections.length, 1);
      assert.equal(fake.tabMessages.length, 1);
      assert.equal(timers.pending(), timersBefore);
    });

    it("fails with page_loading when the tab is still loading at the bound, sending nothing", async () => {
      const { fake, pages, timers, tab } = await grantedTab();
      const timersBefore = timers.pending();
      begin(fake, tab.id, NEXT);
      const { request, settled } = track(pages.request("s1", tab.id, "echo", {}, 0));
      await flush();
      timers.advance(NAVIGATION_WAIT_MS - 1);
      await flush();
      assert.equal(settled(), false);
      timers.advance(1);
      await assert.rejects(request, { code: LOADING.code, message: LOADING.message(tab.id) });
      assertNothingSent(fake);
      assert.equal(timers.pending(), timersBefore);
    });

    it("still refuses about:blank with no navigation under way", async () => {
      const { fake, pages, navigations, tab } = await grantedTab();
      const shown = fake.tabs.get(tab.id);
      assert.ok(shown !== undefined);
      shown.url = "about:blank";
      assert.equal(navigations.underWay(tab.id), false);
      await rejectsWith(pages.request("s1", tab.id, "echo", {}, 0), "page_not_web");
      assertNothingSent(fake);
    });

    it("waits when the first gate meets the swap of a navigation that began during it", async (t) => {
      const { fake, pages, tab } = await grantedTab();
      const get = fake.browser.tabs.get;
      let gets = 0;
      t.mock.method(fake.browser.tabs, "get", async (tabId: number) => {
        gets += 1;
        // The first is the group check before any wait; the second, the first gate's.
        if (gets === 2) {
          begin(fake, tabId, NEXT);
          swap(fake, tabId);
        }
        return get(tabId);
      });
      const request = pages.request("s1", tab.id, "echo", {}, 0);
      await flush();
      assertNothingSent(fake);
      land(fake, tab.id, NEXT, answering("new page"));
      assert.equal(await request, "new page");
      assert.equal(fake.tabMessages.length, 1);
    });

    it("waits when the gate meets the swap of a navigation that began as the last one ended", async () => {
      const { fake, pages, tab } = await grantedTab();
      begin(fake, tab.id, NEXT);
      const request = pages.request("s1", tab.id, "echo", {}, 0);
      await flush();
      land(fake, tab.id, NEXT, answering("next page"));
      // The page's own script moves on as soon as it is parsed.
      begin(fake, tab.id, `${SITE}/last`);
      swap(fake, tab.id);
      await flush();
      assertNothingSent(fake);
      land(fake, tab.id, `${SITE}/last`, answering("last page"));
      assert.equal(await request, "last page");
      assert.equal(fake.tabMessages.length, 1);
    });

    it("waits when the gate after the injection meets the swap, then runs again", async (t) => {
      const { fake, pages, tab } = await grantedTab();
      let injections = 0;
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        injections += 1;
        if (injections === 1) {
          begin(fake, tab.id, NEXT);
          swap(fake, tab.id);
        }
        return [{ frameId: 0, result: null }];
      });
      const request = pages.request("s1", tab.id, "echo", {}, 0);
      await flush();
      assert.deepEqual(fake.tabMessages, []);
      land(fake, tab.id, NEXT, answering("new page"));
      assert.equal(await request, "new page");
      assert.equal(injections, 2);
      assert.equal(fake.tabMessages.length, 1);
    });

    it("runs a read again when a navigation began while the page answered, never returning the old reply", async () => {
      const { fake, pages, timers, tab } = await grantedTab();
      const timersBefore = timers.pending();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, NEXT);
        return { ok: true, site: SITE, result: "old page" };
      });
      const request = pages.request("s1", tab.id, "read_page", {}, 0);
      await flush();
      assert.equal(fake.tabMessages.length, 1);
      land(fake, tab.id, NEXT, answering("new page"));
      assert.equal(await request, "new page");
      assert.equal(fake.tabMessages.length, 2);
      // The leaving document may have taken the first tag.
      assert.deepEqual(tagsSent(fake), ["a", "b"]);
      assert.equal(fake.injections.length, 2);
      assert.equal(timers.pending(), timersBefore);
    });

    it("refuses a stopped session at once, never running a read again after a navigation began", async () => {
      const { fake, pages, access, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, NEXT);
        access.stop("s1");
        return { ok: true, site: SITE, result: "old page" };
      });
      const { request, settled } = track(pages.request("s1", tab.id, "read_page", {}, 0));
      await flush();
      assert.equal(settled(), true);
      await rejectsWith(request, "session_stopped");
      assert.equal(fake.tabMessages.length, 1);
      assert.equal(fake.injections.length, 1);
    });

    it("runs a read at most twice", async () => {
      const { fake, pages, tab } = await grantedTab();
      // Each answer comes from a page that has already moved on, and landed.
      const movingOn = (): ContentScript => async () => {
        begin(fake, tab.id, NEXT);
        land(fake, tab.id, NEXT, movingOn());
        return { ok: true, site: SITE, result: "old page" };
      };
      fake.setContentScript(tab.id, movingOn());
      await rejectsWith(pages.request("s1", tab.id, "read_page", {}, 0), "page_changed");
      assert.equal(fake.tabMessages.length, 2);
      // A page still loading the next one at the end of the second run.
      let answers = 0;
      const leaving: ContentScript = async () => {
        answers += 1;
        begin(fake, tab.id, `${NEXT}/${answers}`);
        return { ok: true, site: SITE, result: "old page" };
      };
      fake.setContentScript(tab.id, leaving);
      const request = pages.request("s1", tab.id, "read_page", {}, 0);
      await flush();
      land(fake, tab.id, NEXT, leaving);
      await assert.rejects(request, { code: LOADING.code, message: LOADING.message(tab.id) });
      assert.equal(answers, 2);
    });

    it("does not run a read again once NAVIGATION_WAIT_MS has passed", async (t) => {
      const { fake, pages, timers, tab } = await grantedTab();
      const { promise: injected, resolve } = Promise.withResolvers<void>();
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        await injected;
        return [{ frameId: 0, result: null }];
      });
      const request = pages.request("s1", tab.id, "read_page", {}, 0);
      await flush();
      timers.advance(NAVIGATION_WAIT_MS);
      begin(fake, tab.id, NEXT);
      land(fake, tab.id, NEXT, answering("new page"));
      resolve();
      await rejectsWith(request, "page_changed");
      assert.deepEqual(fake.tabMessages, []);
    });

    it("fails with page_loading when the navigation begun after NAVIGATION_WAIT_MS is still under way", async (t) => {
      const { fake, pages, timers, tab } = await grantedTab();
      const { promise: injected, resolve } = Promise.withResolvers<void>();
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        await injected;
        return [{ frameId: 0, result: null }];
      });
      const request = pages.request("s1", tab.id, "read_page", {}, 0);
      await flush();
      timers.advance(NAVIGATION_WAIT_MS);
      begin(fake, tab.id, NEXT);
      resolve();
      await assert.rejects(request, { code: LOADING.code, message: LOADING.message(tab.id) });
      assert.deepEqual(fake.tabMessages, []);
    });

    it("sends an act once and returns its reply when its page begins loading another", async () => {
      const { fake, pages, navigations, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, NEXT);
        return { ok: true, site: SITE, result: "clicked" };
      });
      assert.equal(await pages.request("s1", tab.id, "click", {}, 0), "clicked");
      assert.equal(fake.tabMessages.length, 1);
      assert.equal(navigations.underWay(tab.id), true);
    });

    it("waits after an act for the page of a swap, and returns the act's reply", async () => {
      const { fake, pages, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, NEXT);
        swap(fake, tab.id);
        return { ok: true, site: SITE, result: "clicked" };
      });
      const { request, settled } = track(pages.request("s1", tab.id, "click", {}, 0));
      await flush();
      assert.equal(settled(), false);
      land(fake, tab.id, NEXT, answering("new page"));
      assert.equal(await request, "clicked");
      assert.equal(fake.tabMessages.length, 1);
    });

    it("refuses an act's reply at once when its gate fails for another reason during a navigation", async () => {
      const { fake, pages, navigations, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, "https://b.example/");
        // The old document answers while the tab already reports its next URL.
        const shown = fake.tabs.get(tab.id);
        if (shown !== undefined) shown.url = "https://b.example/";
        return { ok: true, site: SITE, result: "clicked" };
      });
      const { request, settled } = track(pages.request("s1", tab.id, "click", {}, 0));
      await flush();
      assert.equal(settled(), true);
      assert.equal(navigations.underWay(tab.id), true);
      await assert.rejects(request, ranChanged(tab.id, "click"));
      assert.equal(fake.tabMessages.length, 1);
    });

    it("refuses an act's reply when the swap lands on another site", async () => {
      const { fake, pages, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, "https://b.example/");
        swap(fake, tab.id);
        return { ok: true, site: SITE, result: "clicked" };
      });
      const request = pages.request("s1", tab.id, "click", {}, 0);
      await flush();
      land(fake, tab.id, "https://b.example/", answering("other site"));
      await assert.rejects(request, ranChanged(tab.id, "click"));
      assert.equal(fake.tabMessages.length, 1);
    });

    it("says an act may already have run when the swap's page is not there at the bound", async () => {
      const { fake, pages, timers, tab } = await grantedTab();
      const timersBefore = timers.pending();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, NEXT);
        swap(fake, tab.id);
        return { ok: true, site: SITE, result: "clicked" };
      });
      const { request, settled } = track(pages.request("s1", tab.id, "click", {}, 0));
      await flush();
      timers.advance(NAVIGATION_WAIT_MS - 1);
      await flush();
      assert.equal(settled(), false);
      timers.advance(1);
      await assert.rejects(request, ranLoading(tab.id, "click"));
      assert.equal(fake.tabMessages.length, 1);
      assert.equal(timers.pending(), timersBefore);
    });

    it("says an act may already have run when its swap comes after NAVIGATION_WAIT_MS, without waiting", async (t) => {
      const { fake, pages, timers, tab } = await grantedTab();
      const timersBefore = timers.pending();
      const { promise: injected, resolve: inject } = Promise.withResolvers<void>();
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        await injected;
        return [{ frameId: 0, result: null }];
      });
      const { promise: answered, resolve: answer } = Promise.withResolvers<void>();
      fake.setContentScript(tab.id, async () => {
        await answered;
        begin(fake, tab.id, NEXT);
        swap(fake, tab.id);
        return { ok: true, site: SITE, result: "clicked" };
      });
      const request = pages.request("s1", tab.id, "click", {}, 0);
      await flush();
      timers.advance(NAVIGATION_WAIT_MS / 2);
      inject();
      await flush();
      assert.equal(fake.tabMessages.length, 1);
      timers.advance(NAVIGATION_WAIT_MS / 2);
      answer();
      await assert.rejects(request, ranLoading(tab.id, "click"));
      assert.equal(timers.pending(), timersBefore);
    });

    it("sends an act in its second run when a navigation began before its message", async (t) => {
      const { fake, pages, tab } = await grantedTab();
      let injections = 0;
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        injections += 1;
        if (injections === 1) begin(fake, tab.id, NEXT);
        return [{ frameId: 0, result: null }];
      });
      const request = pages.request("s1", tab.id, "click", { ref: "a1" }, 0);
      await flush();
      assert.deepEqual(fake.tabMessages, []);
      land(fake, tab.id, NEXT, answering("clicked"));
      assert.equal(await request, "clicked");
      assert.equal(injections, 2);
      assert.equal(fake.tabMessages.length, 1);
    });

    it("never sends an act twice, even when a navigation began while the page answered", async () => {
      const { fake, pages, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, NEXT);
        land(fake, tab.id, NEXT, answering("new page"));
        return { ok: true, site: "https://b.example", result: "clicked" };
      });
      await rejectsWith(pages.request("s1", tab.id, "type", {}, 0), "page_changed");
      assert.equal(fake.tabMessages.length, 1);
    });

    it("calls onSend right before each send of the message, after the injection", async () => {
      const { fake, pages, tab } = await grantedTab();
      fake.setContentScript(tab.id, answering("clicked"));
      const seen: [number, number][] = [];
      const onSend = () => seen.push([fake.injections.length, fake.tabMessages.length]);
      assert.equal(await pages.request("s1", tab.id, "click", {}, 0, onSend), "clicked");
      assert.deepEqual(seen, [[1, 0]]);
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, NEXT);
        return { ok: true, site: SITE, result: "old page" };
      });
      const request = pages.request("s1", tab.id, "read_page", {}, 0, onSend);
      await flush();
      land(fake, tab.id, NEXT, answering("new page"));
      assert.equal(await request, "new page");
      assert.deepEqual(seen, [
        [1, 0],
        [2, 1],
        [3, 2],
      ]);
    });

    it("calls onSend only once a navigation under way has settled", async () => {
      const { fake, pages, tab } = await grantedTab();
      let sends = 0;
      begin(fake, tab.id, NEXT);
      const request = pages.request("s1", tab.id, "click", { ref: "a1" }, 0, () => {
        sends += 1;
      });
      await flush();
      assert.equal(sends, 0);
      land(fake, tab.id, NEXT, answering("clicked"));
      assert.equal(await request, "clicked");
      assert.equal(sends, 1);
    });

    it("refuses a page the navigation brings from a site the session may not act on", async () => {
      const { fake, pages, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        begin(fake, tab.id, "https://c.example/");
        return { ok: true, site: SITE, result: "old page" };
      });
      const request = pages.request("s1", tab.id, "read_page", {}, 0);
      await flush();
      land(fake, tab.id, "https://c.example/", async () => ({
        ok: true,
        site: "https://c.example",
        result: "unapproved page",
      }));
      await rejectsWith(request, "site_not_approved");
      assert.equal(fake.tabMessages.length, 1);
    });

    it("refuses a tab outside the session's group, or one that does not exist, without waiting", async () => {
      const { fake, pages, open, timers, tab } = await grantedTab();
      const timersBefore = timers.pending();
      const other = await open("s2", `${SITE}/`);
      const outside = fake.openTab({ url: `${SITE}/` });
      for (const tabId of [tab.id, other.id, outside.id, 99]) begin(fake, tabId, NEXT);
      for (const [session, tabId, code] of [
        ["s1", other.id, "tab_not_in_group"],
        ["s1", outside.id, "tab_not_in_group"],
        ["s2", tab.id, "tab_not_in_group"],
        ["s1", 99, "tab_not_found"],
      ] as const) {
        await rejectsWith(
          pages.request(session, tabId, "echo", {}, 0),
          code,
          `${session} ${tabId}`,
        );
      }
      assertNothingSent(fake);
      assert.equal(timers.pending(), timersBefore);
    });

    it("refuses a tab outside the session's group as it is, however often it navigates", async (t) => {
      const { fake, pages } = await grantedTab();
      const outside = fake.openTab({ url: `${SITE}/` });
      const get = fake.browser.tabs.get;
      let gets = 0;
      t.mock.method(fake.browser.tabs, "get", async (tabId: number) => {
        gets += 1;
        // The page navigates again during every check of the tab.
        if (tabId === outside.id) begin(fake, tabId, `${NEXT}/${gets}`);
        return get(tabId);
      });
      await rejectsWith(pages.request("s1", outside.id, "read_page", {}, 0), "tab_not_in_group");
      assertNothingSent(fake);
    });

    it("checks the group the same way whether or not a tab outside it is loading", async (t) => {
      const { fake, pages } = await grantedTab();
      const outside = fake.openTab({ url: `${SITE}/` });
      const get = t.mock.method(fake.browser.tabs, "get");
      await rejectsWith(pages.request("s1", outside.id, "read_page", {}, 0), "tab_not_in_group");
      const idle = get.mock.callCount();
      begin(fake, outside.id, NEXT);
      // Counted from here: the update itself may have the page views read the tab.
      const loading = get.mock.callCount();
      await rejectsWith(pages.request("s1", outside.id, "read_page", {}, 0), "tab_not_in_group");
      assert.equal(get.mock.callCount() - loading, idle);
    });

    it("runs in a committed page still parsing at the bound, and holds no later request", async () => {
      const { fake, pages, navigations, timers, tab } = await grantedTab();
      begin(fake, tab.id, NEXT);
      commit(fake, tab.id, NEXT, answering("parsed so far"));
      const { request, settled } = track(pages.request("s1", tab.id, "echo", {}, 0));
      await flush();
      assert.equal(settled(), false);
      timers.advance(NAVIGATION_WAIT_MS);
      assert.equal(await request, "parsed so far");
      assert.equal(navigations.underWay(tab.id), false);
      assert.equal(await pages.request("s1", tab.id, "echo", {}, 0), "parsed so far");
    });

    it("answers within 50 s in the worst case", async (t) => {
      const { fake, pages, timers, tab } = await grantedTab();
      begin(fake, tab.id, NEXT);
      const { request, settled } = track(pages.request("s1", tab.id, "read_page", {}, 0));
      await flush();
      timers.advance(NAVIGATION_WAIT_MS - 1);
      // The page lands just before the cutoff and begins another navigation as it answers.
      const { promise: injected, resolve: inject } = Promise.withResolvers<void>();
      let injections = 0;
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        injections += 1;
        if (injections === 2) await injected;
        return [{ frameId: 0, result: null }];
      });
      land(fake, tab.id, NEXT, async () => {
        begin(fake, tab.id, `${SITE}/last`);
        commit(fake, tab.id, `${SITE}/last`, () => new Promise(() => {}));
        return { ok: true, site: SITE, result: "old page" };
      });
      await flush();
      // The second run waits out the bound, then the injection and the reply take theirs.
      timers.advance(NAVIGATION_WAIT_MS);
      await flush();
      assert.equal(injections, 2);
      timers.advance(PAGE_INJECTION_MS - 1);
      inject();
      await flush();
      timers.advance(PAGE_REPLY_MS - 1);
      await flush();
      assert.equal(settled(), false);
      timers.advance(1);
      await rejectsWith(request, "page_timeout");
    });

    it("bounds a request with its waits below the host's 60 s request timeout", () => {
      assert.equal(NAVIGATION_WAIT_MS, 10_000);
      const worst = 2 * NAVIGATION_WAIT_MS + TAG_RESERVE_MS + PAGE_INJECTION_MS + PAGE_REPLY_MS;
      assert.equal(worst, 55_000);
      assert.equal(PAGE_REQUEST_MS, worst);
      assert.ok(worst < 60_000);
    });
  });

  describe("refuses an act aimed at a point or the focused element on a page loaded meanwhile", () => {
    const NEXT = `${SITE}/next`;
    const unseen = (tabId: number, type: string) => ({
      code: "page_unseen",
      message: `Tab ${tabId} loaded another page before ${type} was sent, so Foxleash did not send it: its point or key was chosen for the page before. Read the page, then act again.`,
    });
    const blind: [string, Record<string, unknown>][] = [
      ["click", { x: 1, y: 2 }],
      ["drag", { ref: "a1", targetX: 3, targetY: 4 }],
      ["drag", { x: 1, y: 2, targetRef: "a2" }],
      ["press_key", { key: "Enter" }],
    ];

    for (const [type, params] of blind) {
      it(`refuses ${type} ${JSON.stringify(params)} that waited for a navigation, sending nothing`, async () => {
        const { fake, pages, tab } = await grantedTab();
        const sends: number[] = [];
        begin(fake, tab.id, NEXT);
        const request = pages.request("s1", tab.id, type, params, 0, () => sends.push(1));
        await flush();
        land(fake, tab.id, NEXT, answering("acted"));
        await assert.rejects(request, unseen(tab.id, type));
        assert.deepEqual(fake.tabMessages, []);
        assert.deepEqual(sends, []);
      });
    }

    it("refuses one when a navigation began and ended between the request's start and its send", async (t) => {
      const { fake, pages, tab } = await grantedTab();
      let injections = 0;
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        injections += 1;
        if (injections === 1) {
          // A 204: the navigation ends without another document.
          begin(fake, tab.id, NEXT);
          fake.emitStatus(tab.id, "complete");
        }
        return [{ frameId: 0, result: null }];
      });
      await assert.rejects(
        pages.request("s1", tab.id, "click", { x: 1, y: 2 }, 0),
        unseen(tab.id, "click"),
      );
      assert.equal(injections, 2);
      assert.deepEqual(fake.tabMessages, []);
    });

    it("refuses at once, without a second run", async () => {
      const { fake, pages, tab } = await grantedTab();
      begin(fake, tab.id, NEXT);
      const request = pages.request("s1", tab.id, "press_key", { key: "a" }, 0);
      await flush();
      land(fake, tab.id, NEXT, answering("pressed"));
      await rejectsWith(request, "page_unseen");
      assert.equal(fake.injections.length, 1);
      assert.deepEqual(fake.tabMessages, []);
    });

    it("sends a ref act after a navigation wait, and a point act with no navigation", async () => {
      const { fake, pages, tab } = await grantedTab();
      begin(fake, tab.id, NEXT);
      const request = pages.request("s1", tab.id, "click", { ref: "a1" }, 0);
      await flush();
      land(fake, tab.id, NEXT, answering("by ref"));
      assert.equal(await request, "by ref");
      assert.equal(await pages.request("s1", tab.id, "click", { x: 1, y: 2 }, 0), "by ref");
      assert.equal(await pages.request("s1", tab.id, "press_key", { key: "a" }, 0), "by ref");
      assert.equal(fake.tabMessages.length, 3);
    });

    it("sends hover and scroll at a point after a navigation wait", async () => {
      for (const type of ["hover", "scroll"]) {
        const { fake, pages, tab } = await grantedTab();
        begin(fake, tab.id, NEXT);
        const request = pages.request("s1", tab.id, type, { x: 1, y: 2 }, 0);
        await flush();
        land(fake, tab.id, NEXT, answering(type));
        assert.equal(await request, type);
        assert.equal(fake.tabMessages.length, 1, type);
      }
    });
  });

  describe("asks for page changes without a document tag", () => {
    it("sends page_changes with tag null, and the next request gets the next tag", async () => {
      const { fake, pages, tab } = await grantedTab();
      fake.setContentScript(tab.id, answering("ok"));
      await pages.request("s1", tab.id, "echo", {}, 0);
      await pages.request("s1", tab.id, "page_changes", { watch: "w" }, 0);
      await pages.request("s1", tab.id, "echo", {}, 0);
      assert.deepEqual(tagsSent(fake), ["a", null, "b"]);
    });
  });

  describe("refuses a request whose session ended while it ran", () => {
    /** A tab on SITE, allowed always, whose injections end s1 first. */
    async function endingTab(t: TestContext): Promise<Env & { tab: TabInfo }> {
      const env = setup();
      await env.grant(SITE);
      const tab = await env.open("s1", `${SITE}/`);
      env.fake.setContentScript(tab.id, contentScript(SITE));
      const { scripting } = env.fake.browser;
      const executeScript = scripting.executeScript;
      t.mock.method(scripting, "executeScript", (...args: Parameters<typeof executeScript>) => {
        env.access.endSession("s1");
        return executeScript(...args);
      });
      return { ...env, tab };
    }

    it("sends nothing and calls no onSend once the session ended", async (t) => {
      const { fake, pages, access, tab } = await endingTab(t);
      let sends = 0;
      const request = pages.request(
        "s1",
        tab.id,
        "click",
        { ref: "a1" },
        access.generation("s1"),
        () => {
          sends += 1;
        },
      );
      await assert.rejects(request, {
        code: "session_ended",
        message: "The session ended before Foxleash could finish the request.",
      });
      assert.equal(sends, 0);
      assert.deepEqual(fake.tabMessages, []);
    });

    it("returns the reply of an act sent before the session ended", async () => {
      const { fake, pages, access, open, grant } = setup();
      await grant(SITE);
      const tab = await open("s1", `${SITE}/`);
      fake.setContentScript(tab.id, async () => {
        access.endSession("s1");
        return { ok: true, site: SITE, result: "clicked" };
      });
      assert.equal(await pages.request("s1", tab.id, "click", { ref: "a1" }, 0), "clicked");
    });

    it("sends no click, upload or read of a tool call, and ends a wait at once", async (t) => {
      for (const [method, params] of [
        ["click", { ref: "a1" }],
        [
          "upload_file",
          { ref: "a1", upload: "none", files: [{ name: "e.txt", type: "text/plain", size: 0 }] },
        ],
        ["read_page", {}],
        ["get_page_text", {}],
        ["wait_for", { text: "Saved" }],
      ] satisfies [MethodName, Record<string, unknown>][]) {
        const { fake, call, tab } = await endingTab(t);
        await rejectsWith(
          call("s1", method, { tabId: tab.id, ...params }),
          "session_ended",
          method,
        );
        assert.deepEqual(fake.tabMessages, [], method);
      }
    });
  });
});

describe("parsePageReply", () => {
  const PAGE_ERROR = {
    code: "page_error",
    message: "Foxleash could not complete the request in the page in tab 7.",
  };
  const TOO_LARGE = {
    code: "page_reply_too_large",
    message: "The answer from the page in tab 7 is too large to return.",
  };

  it("returns the result of a reply from the expected site", () => {
    assert.deepEqual(parsePageReply({ ok: true, site: SITE, result: { a: 1 } }, SITE, 7), {
      a: 1,
    });
    assert.equal(parsePageReply({ ok: true, site: SITE }, SITE, 7), undefined);
  });

  it("refuses a reply from another site", () => {
    for (const site of ["https://b.example", `${SITE}.`, `${SITE}:443`, "https://A.example"]) {
      assert.throws(() => parsePageReply({ ok: true, site, result: 1 }, SITE, 7), {
        code: "page_changed",
        message: "The page in tab 7 changed while Foxleash was working in it; try again.",
      });
    }
  });

  it("refuses a reply that is not an object, or has no site", () => {
    const replies: unknown[] = [
      null,
      undefined,
      "ok",
      1,
      true,
      [],
      [{ ok: true, site: SITE }],
      { ok: true, result: 1 },
      { ok: true, site: 1, result: 1 },
      { ok: true, site: null, result: 1 },
    ];
    for (const reply of replies) {
      assert.throws(() => parsePageReply(reply, SITE, 7), PAGE_ERROR, JSON.stringify(reply));
    }
  });

  it("passes an allowed error code through, with its message", () => {
    for (const code of [
      "invalid_params",
      "invalid_ref",
      "stale_ref",
      "ref_not_found",
      "invalid_target",
      "element_covered",
      "element_not_visible",
      "no_element_at_point",
      "in_frame",
      "cross_site_navigation",
      "protected_get_form",
      "not_editable",
      "no_effect",
    ]) {
      assert.throws(
        () => parsePageReply({ ok: false, site: SITE, code, message: "Plain words." }, SITE, 7),
        (error: unknown) =>
          error instanceof ToolError && error.code === code && error.message === "Plain words.",
      );
    }
  });

  it("cuts an error message to 500 characters without splitting a surrogate pair", () => {
    const long = "a".repeat(600);
    assert.throws(
      () => parsePageReply({ ok: false, site: SITE, code: "stale_ref", message: long }, SITE, 7),
      { code: "stale_ref", message: "a".repeat(500) },
    );
    const straddling = `${"a".repeat(499)}\u{1F600}b`;
    assert.throws(
      () =>
        parsePageReply({ ok: false, site: SITE, code: "stale_ref", message: straddling }, SITE, 7),
      { code: "stale_ref", message: "a".repeat(499) },
    );
    const exact = "a".repeat(500);
    assert.throws(
      () => parsePageReply({ ok: false, site: SITE, code: "stale_ref", message: exact }, SITE, 7),
      { code: "stale_ref", message: exact },
    );
  });

  it("refuses any other error reply", () => {
    const replies: unknown[] = [
      { ok: false, site: SITE, code: "page_error", message: "x" },
      { ok: false, site: SITE, code: "unknown_code", message: "x" },
      { ok: false, site: SITE, code: "__proto__", message: "x" },
      { ok: false, site: SITE, code: "toString", message: "x" },
      { ok: false, site: SITE, code: "STALE_REF", message: "x" },
      { ok: false, site: SITE, code: 1, message: "x" },
      { ok: false, site: SITE, message: "x" },
      { ok: false, site: SITE, code: "stale_ref", message: 1 },
      { ok: false, site: SITE, code: "stale_ref" },
      { ok: "true", site: SITE, result: 1 },
      { ok: 1, site: SITE, result: 1 },
      { site: SITE, result: 1 },
      { site: SITE, code: "stale_ref", message: "x" },
    ];
    for (const reply of replies) {
      assert.throws(() => parsePageReply(reply, SITE, 7), PAGE_ERROR, JSON.stringify(reply));
    }
  });

  it("reads only the reply's own fields", () => {
    const inherited: unknown[] = [
      Object.create({ ok: true, site: SITE, result: 1 }),
      Object.assign(Object.create({ ok: true }), { site: SITE, result: 1 }),
      Object.assign(Object.create({ site: SITE }), { ok: true, result: 1 }),
      Object.assign(Object.create({ code: "stale_ref" }), { ok: false, site: SITE, message: "x" }),
      Object.assign(Object.create({ message: "x" }), { ok: false, site: SITE, code: "stale_ref" }),
    ];
    for (const reply of inherited) {
      assert.throws(() => parsePageReply(reply, SITE, 7), PAGE_ERROR);
    }
    const shadowed: object = Object.assign(Object.create({ result: "inherited" }), {
      ok: true,
      site: SITE,
    });
    assert.equal(parsePageReply(shadowed, SITE, 7), undefined);
  });

  it("caps the reply at MAX_PAGE_REPLY_CHARS characters of JSON", () => {
    const overhead = JSON.stringify({ ok: true, site: SITE, result: "" }).length;
    const fits = { ok: true, site: SITE, result: "a".repeat(2_000_000 - overhead) };
    assert.equal(JSON.stringify(fits).length, 2_000_000);
    assert.equal(parsePageReply(fits, SITE, 7), fits.result);
    const over = { ...fits, result: `${fits.result}a` };
    assert.throws(() => parsePageReply(over, SITE, 7), TOO_LARGE);
    const error = { ok: false, site: SITE, code: "stale_ref", message: "a".repeat(2_000_000) };
    assert.throws(() => parsePageReply(error, SITE, 7), TOO_LARGE);
  });

  it("stops reading a reply as soon as it is sure to be too large", () => {
    const large: [string, unknown][] = [
      ["a long string", "a".repeat(MAX_PAGE_REPLY_CHARS)],
      ["a long String object", new String("a".repeat(MAX_PAGE_REPLY_CHARS))],
      ["a long key", { ["k".repeat(MAX_PAGE_REPLY_CHARS)]: 0 }],
      ["many values", new Array(MAX_PAGE_REPLY_CHARS).fill(0)],
      ["many empty strings", new Array(MAX_PAGE_REPLY_CHARS).fill("")],
      ["many holes", new Array(MAX_PAGE_REPLY_CHARS)],
      ["many undefined elements", new Array(MAX_PAGE_REPLY_CHARS).fill(undefined)],
      ["many functions", new Array(MAX_PAGE_REPLY_CHARS).fill(() => 1)],
      ["many symbols", new Array(MAX_PAGE_REPLY_CHARS).fill(Symbol("s"))],
    ];
    for (const [name, value] of large) {
      let read = false;
      const later = {
        get after() {
          read = true;
          return 1;
        },
      };
      const reply = { ok: true, site: SITE, result: [value, later] };
      assert.throws(() => parsePageReply(reply, SITE, 7), TOO_LARGE, name);
      assert.equal(read, false, name);
    }
  });

  it("refuses a small reply that repeats one object into a JSON text over the cap", () => {
    const shared = { s: "a".repeat(100_000) };
    const reply = { ok: true, site: SITE, result: new Array(1_000).fill(shared) };
    assert.throws(() => parsePageReply(reply, SITE, 7), TOO_LARGE);
  });

  it("refuses a small reply that repeats one object of values JSON leaves out", () => {
    const shared = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, i) => [`k${i}`, undefined]),
    );
    const reply = { ok: true, site: SITE, result: new Array(10_000).fill(shared) };
    assert.ok(JSON.stringify(reply).length < 100_000);
    assert.throws(() => parsePageReply(reply, SITE, 7), TOO_LARGE);
  });

  it("counts a value JSON leaves out of an object as one, without its key", () => {
    const keyed = (name: string) => `${"u".repeat(100)}${name}`;
    const left = Object.fromEntries(
      Array.from({ length: 98 }, (_, i) => [keyed(`${i}`), undefined]),
    );
    // The reply, ok, site and result, then the string's characters and one per left-out value.
    const counted = 1 + ("ok".length + 1) + ("site".length + SITE.length) + "result".length;
    const reply = (chars: number) => ({
      ok: true,
      site: SITE,
      result: "a".repeat(chars),
      ...left,
      [keyed("f")]: () => 1,
      [keyed("s")]: Symbol("s"),
    });
    const at = reply(MAX_PAGE_REPLY_CHARS - counted - 100);
    assert.ok(JSON.stringify(at).length < MAX_PAGE_REPLY_CHARS);
    assert.equal(parsePageReply(at, SITE, 7), at.result);
    const over = reply(MAX_PAGE_REPLY_CHARS - counted - 99);
    assert.ok(JSON.stringify(over).length < MAX_PAGE_REPLY_CHARS);
    assert.throws(() => parsePageReply(over, SITE, 7), TOO_LARGE);
  });

  it("counts no keys for the elements of an array", () => {
    const zeros = new Array(500_000).fill(0);
    const overhead = JSON.stringify({ ok: true, site: SITE, result: [zeros, ""] }).length;
    const fits = { ok: true, site: SITE, result: [zeros, "a".repeat(2_000_000 - overhead)] };
    assert.equal(JSON.stringify(fits).length, 2_000_000);
    assert.deepEqual(parsePageReply(fits, SITE, 7), fits.result);
  });

  it("refuses a reply nested too deeply to stringify as too large", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 100_000; level += 1) deep = { a: deep };
    assert.throws(() => parsePageReply({ ok: true, site: SITE, result: deep }, SITE, 7), TOO_LARGE);
  });

  it("refuses a cyclic reply or one with a BigInt", () => {
    const cyclic: Record<string, unknown> = { ok: true, site: SITE };
    cyclic.result = cyclic;
    assert.throws(() => parsePageReply(cyclic, SITE, 7), PAGE_ERROR);
    assert.throws(() => parsePageReply({ ok: true, site: SITE, result: 1n }, SITE, 7), PAGE_ERROR);
  });

  it("refuses a reply that stringifies to nothing", () => {
    assert.throws(
      () => parsePageReply({ ok: true, site: SITE, result: 1, toJSON: () => undefined }, SITE, 7),
      PAGE_ERROR,
    );
  });
});

type Env = ReturnType<typeof setup>;

interface Change {
  name: string;
  code: string;
  change: (env: Env, tabId: number) => unknown;
}

function setup() {
  const fake = createFakeBrowser();
  const timers = createFakeTimers();
  const groups = createSessionGroups(fake.browser);
  const sessions: SessionMemory = new Map();
  const access = createSiteAccess({ browser: fake.browser, groups, sessions, timers });
  const navigations = createTabNavigations({ browser: fake.browser, timers });
  const files = createFileGuard({ browser: fake.browser, groups, access, now: () => Date.now() });
  // Its own clock, so the timer a wait that saw no request leaves is not among the pending ones.
  const hops = createLoadHops({ browser: fake.browser, access, timers: createFakeTimers() });
  const pages = createPageScripts({ browser: fake.browser, groups, access, timers, navigations });
  const network = {
    read: () => ({ recording: false, requests: [], truncated: false }),
    requestsSince: () => ({ begun: 0, open: 0 }),
  };
  const settle = createActSettle({
    browser: fake.browser,
    groups,
    access,
    timers,
    navigations,
    network,
    files,
    pages,
    now: () => 0,
  });
  const handleRequest = createHandlers({
    browser: fake.browser,
    groups,
    timers,
    access,
    probe: async () => null,
    pages,
    navigations,
    uploads: createUploads(timers),
    recordings: { liveRecording: () => undefined },
    network,
    files,
    hops,
    downloads: { save: async () => ({ path: "", bytes: 0 }) },
    recipes: {
      propose: () => Promise.reject(new Error("unused")),
      run: () => Promise.reject(new Error("unused")),
      request: () => Promise.reject(new Error("unused")),
      openPrompt: () => undefined,
    },
    settle,
    views: createPageViews({ browser: fake.browser, groups, access }),
    now: () => timers.now(),
  });
  let requests = 0;
  // The view's read is a page request of its own, which these tests do not count.
  const call = (session: string, method: MethodName, params: Record<string, unknown> = {}) =>
    handleRequest({
      type: "request",
      id: `r${++requests}`,
      session,
      method,
      params: { ...params, view: false },
    });

  async function open(session: string, url?: string): Promise<TabInfo> {
    const result = await call(session, "tab_open", url === undefined ? {} : { url });
    assert.ok("tab" in result);
    return result.tab;
  }

  function grant(site: string): Promise<void> {
    return grantSite(fake.browser, site);
  }

  /** The session's open prompt, once its page has been loaded. */
  async function promptOf(session: string): Promise<OpenPrompt> {
    for (let turn = 0; turn < 50; turn += 1) {
      const prompt = access.openPrompt(session);
      if (prompt !== undefined) return prompt;
      await flush();
    }
    assert.fail(`session ${session} has no prompt`);
  }

  /** The page scripts of a background started again, on the same browser. */
  function restart() {
    return createPageScripts({ browser: fake.browser, groups, access, timers, navigations });
  }

  return {
    fake,
    timers,
    sessions,
    access,
    navigations,
    pages,
    call,
    open,
    grant,
    promptOf,
    restart,
  };
}

/** A content script on `site` that answers with Foxleash's dispatcher. */
function contentScript(site: string): ContentScript {
  const handlers: PageHandlers = {
    echo: (params) => ({ echoed: params }),
    stale: () => {
      throw new PageError("stale_ref", "Element x-1 is from a page the tab no longer shows.");
    },
    secret: () => {
      throw new Error(`secret ${site}/private`);
    },
  };
  return (message) => handlePageMessage(message, { site, handlers, adopt: noop, before: noop });
}

/** The tag of each message sent, in order. */
function tagsSent(fake: { tabMessages: TabMessage[] }): unknown[] {
  return fake.tabMessages.map(({ message }) =>
    typeof message === "object" && message !== null ? Reflect.get(message, "tag") : undefined,
  );
}

/** The stored tag mark. */
async function storedMark(fake: Env["fake"]): Promise<unknown> {
  return (await fake.browser.storage.local.get(null))[TAG_MARK_KEY];
}

/** Collects what is logged with console.warn, parsed. */
function warnings(t: TestContext): () => unknown[] {
  const warn = t.mock.method(console, "warn", () => {});
  return () => warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
}

function assertNothingSent(fake: { injections: unknown[]; tabMessages: unknown[] }): void {
  assert.deepEqual(fake.injections, []);
  assert.deepEqual(fake.tabMessages, []);
}

function track(request: Promise<unknown>): { request: Promise<unknown>; settled: () => boolean } {
  let done = false;
  request.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { request, settled: () => done };
}

async function rejectsWith(promise: Promise<unknown>, code: string, label?: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ToolError && error.code === code,
    label,
  );
}

function noop(): void {}

/** A content script whose every answer is `result`, on SITE. */
function answering(result: unknown): ContentScript {
  return async () => ({ ok: true, site: SITE, result });
}

/** Firefox begins a navigation of the tab's top frame; the tab still shows its page. */
function begin(fake: Env["fake"], tabId: number, url: string): void {
  fake.emitBeforeNavigate({ tabId, frameId: 0, url });
  if (fake.tabs.has(tabId)) fake.emitStatus(tabId, "loading");
}

/** The tab shows about:blank, as while Firefox swaps the new document in. */
function swap(fake: Env["fake"], tabId: number): void {
  const shown = fake.tabs.get(tabId);
  if (shown !== undefined) shown.url = "about:blank";
}

/** The navigation's document commits, with `script` its content script, and is still parsing. */
function commit(fake: Env["fake"], tabId: number, url: string, script: ContentScript): void {
  const shown = fake.tabs.get(tabId);
  if (shown !== undefined) shown.url = url;
  fake.setContentScript(tabId, script);
  fake.emitCommitted({ tabId, frameId: 0, url });
}

/** The navigation's document commits, with `script` its content script, and is parsed. */
function land(fake: Env["fake"], tabId: number, url: string, script: ContentScript): void {
  commit(fake, tabId, url, script);
  fake.emitDOMContentLoaded({ tabId, frameId: 0, url });
}
