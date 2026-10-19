import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MethodName, TabInfo } from "@foxhand/protocol";
import { type ContentScript, createFakeBrowser, createFakeTimers, flush } from "./fake-browser.ts";
import { createHandlers, ToolError } from "./handlers.ts";
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
  parsePageReply,
} from "./page-scripts.ts";
import { createSessionGroups } from "./session-groups.ts";
import { grantSite, revokeSite } from "./settings.ts";
import { createSiteAccess, type OpenPrompt, type SessionMemory } from "./site-access.ts";

const SITE = "https://a.example";

describe("page script requests", { timeout: 10000 }, () => {
  it("refuses a tab that does not exist", async () => {
    const { fake, pages, open } = setup();
    await open("s1");
    await assert.rejects(pages.request("s1", 99, "echo", {}), {
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
      await assert.rejects(pages.request(session, tabId, "echo", {}), {
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
    await assert.rejects(pages.request("s1", prompt.tabId, "echo", {}), {
      code: "approval_pending",
      message: `Foxhand is waiting for the user to answer in tab ${prompt.tabId} whether to allow ${SITE}. Try again after the user has answered.`,
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
      await assert.rejects(pages.request("s1", tab.id, "echo", {}), {
        code: "page_not_web",
        message: `Foxhand acts only on http and https pages, and tab ${tab.id} shows another kind of page.`,
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
        "Foxhand does not act on https://www.paypal.com: it is on Foxhand's blocklist, which by default lists common financial and health sites.",
    };
    await assert.rejects(pages.request("s1", tab.id, "echo", {}), blocked);
    await grant("https://www.paypal.com");
    await assert.rejects(pages.request("s1", tab.id, "echo", {}), blocked);
    assertNothingSent(fake);
  });

  it("refuses a site the session may not act on, without asking", async () => {
    const { fake, pages, open, access } = setup();
    const tab = await open("s1");
    fake.navigateByUser(tab.id, `${SITE}/x`);
    await flush();
    await assert.rejects(pages.request("s1", tab.id, "echo", {}), {
      code: "site_not_approved",
      message: `Foxhand is not allowed on ${SITE} in this session; call navigate with tab ${tab.id} and action reload to ask the user.`,
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
    assert.deepEqual(await pages.request("s1", tab.id, "echo", params), { answer: 42 });
    assert.deepEqual(fake.injections, [
      { tabId: tab.id, frameIds: [0], files: [CONTENT_SCRIPT], injectImmediately: true },
    ]);
    const message = { kind: "foxhand-page", type: "echo", site: SITE, params };
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
    await pages.request("s1", tab.id, "echo", {});
    await pages.request("s1", tab.id, "echo", {});
    assert.equal(fake.injections.length, 2);
    assert.equal(fake.tabMessages.length, 2);
  });

  it("acts on a site the session allowed only for itself", async () => {
    const { fake, pages, open, sessions } = setup();
    const tab = await open("s1");
    fake.navigateByUser(tab.id, `${SITE}/`);
    await flush();
    sessions.set("s1", { allowed: new Set([SITE]), refused: new Set(), closed: 0 });
    fake.setContentScript(tab.id, contentScript(SITE));
    assert.deepEqual(await pages.request("s1", tab.id, "echo", { a: 1 }), { echoed: { a: 1 } });
  });

  it("round-trips through the content script's dispatcher, its errors included", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, contentScript(SITE));
    assert.deepEqual(await pages.request("s1", tab.id, "echo", { a: [1, "b"] }), {
      echoed: { a: [1, "b"] },
    });
    await assert.rejects(pages.request("s1", tab.id, "stale", {}), {
      code: "stale_ref",
      message: "Element x-1 is from a page the tab no longer shows.",
    });
    await assert.rejects(pages.request("s1", tab.id, "secret", {}), {
      code: "page_error",
      message: `Foxhand could not complete the request in the page in tab ${tab.id}.`,
    });
    await assert.rejects(pages.request("s1", tab.id, "toString", {}), {
      code: "invalid_params",
      message: "Foxhand's page script has no request of that type.",
    });
  });

  it("is refused by a content script whose document is on another site", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    const calls: unknown[] = [];
    const handlers: PageHandlers = { echo: (params) => calls.push(params) };
    for (const site of ["https://b.example", undefined]) {
      fake.setContentScript(tab.id, (message) => handlePageMessage(message, { site, handlers }));
      await assert.rejects(pages.request("s1", tab.id, "echo", {}), {
        code: "page_changed",
        message: `The page in tab ${tab.id} changed while Foxhand was working in it; try again.`,
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
        await rejectsWith(pages.request("s1", tab.id, "echo", {}), code);
        assert.deepEqual(fake.tabMessages, []);
      });
    }

    it("refuses a site the session forgot meanwhile, sending nothing", async (t) => {
      const { fake, pages, access, tab } = await sessionAllowedTab();
      t.mock.method(fake.browser.scripting, "executeScript", async () => {
        access.forget("s1", SITE);
        return [{ frameId: 0, result: null }];
      });
      await rejectsWith(pages.request("s1", tab.id, "echo", {}), "site_not_approved");
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
        await rejectsWith(pages.request("s1", tab.id, "echo", {}), code);
        assert.equal(fake.tabMessages.length, 1);
      });
    }

    it("refuses the answer from a site the session forgot meanwhile", async () => {
      const { fake, pages, access, tab } = await sessionAllowedTab();
      fake.setContentScript(tab.id, async () => {
        access.forget("s1", SITE);
        return { ok: true, site: SITE, result: "page text" };
      });
      await rejectsWith(pages.request("s1", tab.id, "echo", {}), "site_not_approved");
    });

    it("refuses the answer from a tab that shows another allowed site by then", async () => {
      const { fake, pages, tab } = await grantedTab();
      fake.setContentScript(tab.id, async () => {
        // The old document answers while the tab already reports its next URL.
        const shown = fake.tabs.get(tab.id);
        if (shown !== undefined) shown.url = "https://b.example/";
        return { ok: true, site: SITE, result: "page text" };
      });
      await rejectsWith(pages.request("s1", tab.id, "echo", {}), "page_changed");
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
    await assert.rejects(pages.request("s1", tab.id, "echo", {}), {
      code: "page_unreachable",
      message: `Firefox did not let Foxhand into the page in tab ${tab.id}.`,
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
    await assert.rejects(pages.request("s1", tab.id, "echo", {}), {
      code: "page_unreachable",
      message: `Firefox did not let Foxhand into the page in tab ${tab.id}.`,
    });
    assert.deepEqual(fake.tabMessages, []);
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
      await rejectsWith(pages.request("s1", tab.id, "echo", {}), "page_unreachable", name);
      assert.deepEqual(fake.tabMessages, []);
    });
  }

  it("takes frame 0 among others, with or without a result", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, contentScript(SITE));
    fake.injectionResults = [{ frameId: 3, error: new Error("boom") }, { frameId: 0 }];
    assert.deepEqual(await pages.request("s1", tab.id, "echo", {}), { echoed: {} });
  });

  it("times out an injection that never settles, sending nothing", async (t) => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    const timersBefore = timers.pending();
    fake.setContentScript(tab.id, contentScript(SITE));
    t.mock.method(fake.browser.scripting, "executeScript", () => new Promise(() => {}));
    const { request, settled } = track(pages.request("s1", tab.id, "echo", {}));
    await flush();
    timers.advance(PAGE_INJECTION_MS - 1);
    await flush();
    assert.equal(settled(), false);
    timers.advance(1);
    await assert.rejects(request, {
      code: "page_timeout",
      message: `Foxhand could not get into the page in tab ${tab.id} in time; try again.`,
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
    const { request, settled } = track(pages.request("s1", tab.id, "echo", {}));
    await flush();
    assert.equal(fake.tabMessages.length, 1);
    timers.advance(PAGE_REPLY_MS - 1);
    await flush();
    assert.equal(settled(), false);
    timers.advance(1);
    await assert.rejects(request, {
      code: "page_timeout",
      message: `The page in tab ${tab.id} did not answer Foxhand within 10 seconds; try again.`,
    });
    assert.equal(timers.pending(), timersBefore);
  });

  it("bounds both waits below the host's 60 s request timeout, as probe_input does", () => {
    assert.equal(PAGE_INJECTION_MS, 20_000);
    assert.equal(PAGE_REPLY_MS, 10_000);
  });

  it("refuses when no content script answers in the tab", async () => {
    const { fake, pages, open, grant, timers } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    const timersBefore = timers.pending();
    await assert.rejects(pages.request("s1", tab.id, "echo", {}), {
      code: "page_changed",
      message: `The page in tab ${tab.id} changed while Foxhand was working in it; try again.`,
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
      const request = pages.request("s1", tab.id, "echo", {});
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
    await rejectsWith(pages.request("s1", tab.id, "echo", {}), "page_changed");
    assert.equal(fake.tabMessages.length, 1);
  });

  it("refuses a reply that cannot be cloned", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, async () => ({ ok: true, site: SITE, result: () => 1 }));
    await rejectsWith(pages.request("s1", tab.id, "echo", {}), "page_changed");
  });

  it("checks the reply", async () => {
    const { fake, pages, open, grant } = setup();
    await grant(SITE);
    const tab = await open("s1", `${SITE}/`);
    fake.setContentScript(tab.id, async () => ({ ok: true, site: "https://b.example" }));
    await rejectsWith(pages.request("s1", tab.id, "echo", {}), "page_changed");
    fake.setContentScript(tab.id, async () => undefined);
    await rejectsWith(pages.request("s1", tab.id, "echo", {}), "page_error");
  });
});

describe("parsePageReply", () => {
  const PAGE_ERROR = {
    code: "page_error",
    message: "Foxhand could not complete the request in the page in tab 7.",
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
        message: "The page in tab 7 changed while Foxhand was working in it; try again.",
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
    for (const code of ["invalid_params", "invalid_ref", "stale_ref", "ref_not_found"]) {
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
  const pages = createPageScripts({ browser: fake.browser, groups, access, timers });
  const handleRequest = createHandlers({
    browser: fake.browser,
    groups,
    timers,
    access,
    probe: async () => null,
    pages,
  });
  let requests = 0;
  const call = (session: string, method: MethodName, params: Record<string, unknown> = {}) =>
    handleRequest({ type: "request", id: `r${++requests}`, session, method, params });

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

  return { fake, timers, sessions, access, pages, call, open, grant, promptOf };
}

/** A content script on `site` that answers with Foxhand's dispatcher. */
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
  return (message) => handlePageMessage(message, { site, handlers });
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
