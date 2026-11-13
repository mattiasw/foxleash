import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capText,
  handlePageMessage,
  isPageTag,
  MAX_PAGE_REPLY_CHARS,
  MAX_TAG_LETTERS,
  ownField,
  PAGE_ERROR_CODES,
  PAGE_REQUEST_KIND,
  PageError,
  type PageHandlers,
} from "./page-messages.ts";

const SITE = "https://a.example";
const TAG = "b";
const UNREADABLE = {
  ok: false,
  site: SITE,
  code: "invalid_params",
  message: "Foxleash's page script got a request it cannot read.",
};
const NO_SUCH_TYPE = {
  ok: false,
  site: SITE,
  code: "invalid_params",
  message: "Foxleash's page script has no request of that type.",
};
const CHANGED = {
  ok: false,
  code: "page_changed",
  message: "The page changed while Foxleash was working in it; try again.",
};
const FAILED = {
  ok: false,
  site: SITE,
  code: "page_error",
  message: "The request failed in the page.",
};

describe("handlePageMessage", () => {
  it("answers nothing, synchronously, to a message that is not a Foxleash page request", () => {
    const calls: unknown[] = [];
    const handlers: PageHandlers = { echo: (params) => calls.push(params) };
    const messages: unknown[] = [
      undefined,
      null,
      "foxleash-page",
      42,
      [PAGE_REQUEST_KIND],
      {},
      { kind: "other", type: "echo", site: SITE, params: {} },
      { type: "echo", site: SITE, params: {} },
      Object.create({ kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: {} }),
    ];
    for (const message of messages) {
      assert.equal(
        handlePageMessage(message, { site: SITE, handlers, adopt: noop, before: noop }),
        undefined,
      );
    }
    assert.deepEqual(calls, []);
  });

  it("refuses a request whose fields have the wrong type", async () => {
    const calls: unknown[] = [];
    const handlers: PageHandlers = { echo: (params) => calls.push(params) };
    const requests: unknown[] = [
      { kind: PAGE_REQUEST_KIND, tag: TAG, site: SITE, params: {} },
      { kind: PAGE_REQUEST_KIND, tag: TAG, type: 1, site: SITE, params: {} },
      { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", params: {} },
      { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: 1, params: {} },
      { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE },
      { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: null },
      { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: [] },
      { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: "x" },
      withInherited(
        { kind: PAGE_REQUEST_KIND, tag: TAG, site: SITE, params: {} },
        { type: "echo" },
      ),
      withInherited(
        { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", params: {} },
        { site: SITE },
      ),
      withInherited(
        { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE },
        { params: {} },
      ),
    ];
    for (const request of requests) {
      assert.deepEqual(
        await handlePageMessage(request, { site: SITE, handlers, adopt: noop, before: noop }),
        UNREADABLE,
        JSON.stringify(request),
      );
    }
    assert.deepEqual(calls, []);
  });

  it("refuses a request without a well-formed tag, and adopts none", async () => {
    const calls: unknown[] = [];
    const adopted: string[] = [];
    const handlers: PageHandlers = { echo: (params) => calls.push(params) };
    const request = { kind: PAGE_REQUEST_KIND, type: "echo", site: SITE, params: {} };
    const requests: unknown[] = [
      request,
      { ...request, tag: 1 },
      { ...request, tag: null },
      { ...request, tag: ["b"] },
      { ...request, tag: "" },
      { ...request, tag: "B" },
      { ...request, tag: "aB" },
      { ...request, tag: "abcdefgh" },
      { ...request, tag: "a1" },
      { ...request, tag: " b" },
      { ...request, tag: "b\n" },
      { ...request, tag: "é" },
      withInherited(request, { tag: TAG }),
    ];
    for (const each of requests) {
      assert.deepEqual(
        await handlePageMessage(each, {
          site: SITE,
          handlers,
          adopt: (tag) => adopted.push(tag),
          before: noop,
        }),
        UNREADABLE,
        JSON.stringify(each),
      );
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(adopted, []);
  });

  it("adopts the tag of a readable request before its handler runs", async () => {
    const calls: string[] = [];
    const handlers: PageHandlers = {
      echo: () => {
        calls.push("handler");
        return "echoed";
      },
    };
    const ctx = {
      handlers,
      adopt: (tag: string) => calls.push(`adopt ${tag}`),
      before: () => calls.push("before"),
    };
    const request = {
      kind: PAGE_REQUEST_KIND,
      tag: "abcdefg",
      type: "echo",
      site: SITE,
      params: {},
    };
    assert.deepEqual(await handlePageMessage(request, { ...ctx, site: SITE }), {
      ok: true,
      site: SITE,
      result: "echoed",
    });
    assert.deepEqual(calls, ["adopt abcdefg", "before", "handler"]);
    calls.length = 0;
    // Also when the request is then refused: the tag is the request's, whatever its fate.
    assert.deepEqual(await handlePageMessage(request, { ...ctx, site: "https://b.example" }), {
      ...CHANGED,
      site: "https://b.example",
    });
    assert.deepEqual(
      await handlePageMessage({ ...request, tag: "z", type: "missing" }, { ...ctx, site: SITE }),
      NO_SUCH_TYPE,
    );
    assert.deepEqual(calls, ["adopt abcdefg", "adopt z"]);
  });

  it("refuses a request for another site without running its handler", async () => {
    const calls: unknown[] = [];
    const handlers: PageHandlers = { echo: (params) => calls.push(params) };
    const request = { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: {} };
    assert.deepEqual(
      await handlePageMessage(request, {
        site: "https://b.example",
        handlers,
        adopt: noop,
        before: noop,
      }),
      {
        ...CHANGED,
        site: "https://b.example",
      },
    );
    assert.deepEqual(
      await handlePageMessage(request, { site: undefined, handlers, adopt: noop, before: noop }),
      {
        ...CHANGED,
        site: "",
      },
    );
    assert.deepEqual(calls, []);
  });

  for (const type of ["missing", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
    it(`refuses the request type ${type}`, async () => {
      const calls: unknown[] = [];
      const handlers: PageHandlers = { echo: (params) => calls.push(params) };
      const request = { kind: PAGE_REQUEST_KIND, tag: TAG, type, site: SITE, params: {} };
      assert.deepEqual(
        await handlePageMessage(request, { site: SITE, handlers, adopt: noop, before: noop }),
        NO_SUCH_TYPE,
      );
      assert.deepEqual(calls, []);
    });
  }

  it("runs the handler with the params and replies with its result", async () => {
    const calls: unknown[] = [];
    const handlers: PageHandlers = {
      echo: (params) => {
        calls.push(params);
        return { echoed: params.text };
      },
      later: async () => "done",
    };
    const params = { text: "hi" };
    assert.deepEqual(
      await handlePageMessage(
        { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params },
        { site: SITE, handlers, adopt: noop, before: noop },
      ),
      { ok: true, site: SITE, result: { echoed: "hi" } },
    );
    assert.deepEqual(calls, [params]);
    assert.equal(calls[0], params);
    assert.deepEqual(
      await handlePageMessage(
        { kind: PAGE_REQUEST_KIND, tag: TAG, type: "later", site: SITE, params: {} },
        { site: SITE, handlers, adopt: noop, before: noop },
      ),
      { ok: true, site: SITE, result: "done" },
    );
  });

  it("replies with a PageError's code and message, thrown or rejected", async () => {
    const handlers: PageHandlers = {
      thrown: () => {
        throw new PageError("ref_not_found", "Element x is gone.");
      },
      rejected: async () => {
        throw new PageError("stale_ref", "Element y is old.");
      },
    };
    assert.deepEqual(await call(handlers, "thrown"), {
      ok: false,
      site: SITE,
      code: "ref_not_found",
      message: "Element x is gone.",
    });
    assert.deepEqual(await call(handlers, "rejected"), {
      ok: false,
      site: SITE,
      code: "stale_ref",
      message: "Element y is old.",
    });
  });

  it("replies page_error with a fixed sentence to any other failure", async () => {
    const handlers: PageHandlers = {
      error: () => {
        throw new Error("secret https://a.example/private");
      },
      rejected: () => Promise.reject(new TypeError("secret too")),
      text: () => {
        throw "secret string";
      },
    };
    for (const type of ["error", "rejected", "text"]) {
      const reply = await call(handlers, type);
      assert.deepEqual(reply, FAILED, type);
      assert.equal(JSON.stringify(reply).includes("secret"), false);
    }
  });

  it("runs before once, right before a sync or an async handler starts", async () => {
    for (const later of [false, true]) {
      const calls: string[] = [];
      const handlers: PageHandlers = {
        act: later
          ? async () => {
              calls.push("handler");
              return "done";
            }
          : () => {
              calls.push("handler");
              return "done";
            },
      };
      const reply = handlePageMessage(
        { kind: PAGE_REQUEST_KIND, tag: TAG, type: "act", site: SITE, params: {} },
        { site: SITE, handlers, adopt: noop, before: () => calls.push("before") },
      );
      assert.deepEqual(calls, ["before", "handler"], `async: ${later}`);
      assert.deepEqual(await reply, { ok: true, site: SITE, result: "done" });
      assert.deepEqual(calls, ["before", "handler"], `async: ${later}`);
    }
  });

  it("runs before for no request that reaches no handler", async () => {
    let runs = 0;
    const handlers: PageHandlers = { echo: () => "echoed" };
    const before = () => {
      runs += 1;
    };
    const requests: [unknown, string | undefined][] = [
      [{ kind: "other", type: "echo", site: SITE, params: {} }, SITE],
      [{ kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: null }, SITE],
      [
        { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: {} },
        "https://b.example",
      ],
      [{ kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: {} }, undefined],
      [{ kind: PAGE_REQUEST_KIND, tag: TAG, type: "missing", site: SITE, params: {} }, SITE],
    ];
    for (const [request, site] of requests) {
      const reply = await handlePageMessage(request, { site, handlers, adopt: noop, before });
      assert.notEqual(reply?.ok, true, JSON.stringify(request));
      assert.equal(runs, 0, JSON.stringify(request));
    }
  });

  it("fails the request without running the handler when before throws", async () => {
    const calls: unknown[] = [];
    const handlers: PageHandlers = { echo: (params) => calls.push(params) };
    const reply = await handlePageMessage(
      { kind: PAGE_REQUEST_KIND, tag: TAG, type: "echo", site: SITE, params: {} },
      {
        site: SITE,
        handlers,
        adopt: noop,
        before: () => {
          throw new Error("secret https://a.example/private");
        },
      },
    );
    assert.deepEqual(reply, FAILED);
    assert.equal(JSON.stringify(reply).includes("secret"), false);
    assert.deepEqual(calls, []);
  });

  function call(handlers: PageHandlers, type: string): Promise<unknown> | undefined {
    return handlePageMessage(
      { kind: PAGE_REQUEST_KIND, tag: TAG, type, site: SITE, params: {} },
      { site: SITE, handlers, adopt: noop, before: noop },
    );
  }
});

describe("isPageTag", () => {
  it("takes 1 to 7 lowercase letters", () => {
    assert.equal(MAX_TAG_LETTERS, 7);
    for (const tag of ["a", "z", "ab", "zzzzzzz"]) assert.equal(isPageTag(tag), true, tag);
    for (const tag of ["", "zzzzzzzz", "A", "a1", "a-", 1, undefined, new String("a")]) {
      assert.equal(isPageTag(tag), false, String(tag));
    }
  });
});

describe("capText", () => {
  it("keeps text at or under the cap whole", () => {
    assert.deepEqual(capText("abc", 4), { text: "abc", truncated: false, total: 3 });
    assert.deepEqual(capText("abcd", 4), { text: "abcd", truncated: false, total: 4 });
    assert.deepEqual(capText("", 0), { text: "", truncated: false, total: 0 });
  });

  it("cuts text over the cap and reports its whole length", () => {
    assert.deepEqual(capText("abcdef", 4), { text: "abcd", truncated: true, total: 6 });
    assert.deepEqual(capText("abc", 0), { text: "", truncated: true, total: 3 });
  });

  it("drops a surrogate pair that straddles the cap whole", () => {
    // "ab" then U+1F600 as two UTF-16 units, then "c".
    const text = "ab\u{1F600}c";
    assert.deepEqual(capText(text, 3), { text: "ab", truncated: true, total: 5 });
    assert.deepEqual(capText(text, 4), { text: "ab\u{1F600}", truncated: true, total: 5 });
    assert.deepEqual(capText("\u{1F600}", 1), { text: "", truncated: true, total: 2 });
  });

  it("keeps a low surrogate or a plain character at the cut", () => {
    assert.deepEqual(capText("a\uDC00b", 2), { text: "a\uDC00", truncated: true, total: 3 });
    assert.deepEqual(capText("a퟿b", 2), { text: "a퟿", truncated: true, total: 3 });
    assert.deepEqual(capText("a\uDBFFb", 2), { text: "a", truncated: true, total: 3 });
    assert.deepEqual(capText("a\uD800b", 2), { text: "a", truncated: true, total: 3 });
  });
});

describe("ownField", () => {
  it("reads own keys only", () => {
    const value: object = Object.assign(Object.create({ inherited: 1 }), { own: 2 });
    assert.equal(ownField(value, "own"), 2);
    assert.equal(ownField(value, "inherited"), undefined);
    assert.equal(ownField(value, "missing"), undefined);
    assert.equal(ownField({}, "toString"), undefined);
  });
});

describe("the page constants", () => {
  it("lists the codes a content script may return", () => {
    assert.deepEqual(PAGE_ERROR_CODES, [
      "invalid_params",
      "invalid_ref",
      "stale_ref",
      "ref_not_found",
      "page_changed",
      "invalid_target",
      "element_covered",
      "element_not_visible",
      "no_element_at_point",
      "in_frame",
      "cross_site_navigation",
      "not_editable",
      "no_effect",
    ]);
    assert.equal(PAGE_REQUEST_KIND, "foxleash-page");
    assert.equal(MAX_PAGE_REPLY_CHARS, 2_000_000);
  });
});

function withInherited(own: object, inherited: object): object {
  return Object.assign(Object.create(inherited), own);
}

function noop(): void {}
