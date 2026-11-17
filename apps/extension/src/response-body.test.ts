import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  MAX_NETWORK_RESPONSE_BYTES,
  MAX_NETWORK_RESPONSE_TEXT,
  type NetworkResponseBody,
} from "@foxleash/protocol";
import type { HttpHeader } from "./browser-api.ts";
import { createFakeBrowser, type FakeStreamFilter } from "./fake-browser.ts";
import {
  type CaptureHooks,
  captureResponse,
  REDACTED,
  type ResponseCapture,
  redactTokens,
  responseBody,
  textEncoding,
  type Wanted,
} from "./response-body.ts";

const JSON_TYPE: HttpHeader[] = [{ name: "Content-Type", value: "application/json" }];
// header.payload.signature, as a sign-in service issues one.
const TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("textEncoding", () => {
  it("takes text, JSON, XML, JavaScript and form types, in any case", () => {
    for (const value of [
      "text/plain",
      "text/html; charset=utf-8",
      "TEXT/CSV",
      "application/json",
      " Application/JSON ; charset=UTF-8",
      "application/problem+json",
      "application/ld+json",
      "application/xml",
      "application/atom+xml",
      "application/javascript",
      "application/x-www-form-urlencoded",
    ]) {
      assert.equal(textEncoding([{ name: "content-type", value }]), "utf-8", value);
    }
  });

  it("refuses other types, an event stream, and no or several Content-Type headers", () => {
    for (const value of [
      "text/event-stream",
      "Text/Event-Stream; charset=utf-8",
      "image/png",
      "application/octet-stream",
      "application/pdf",
      "application/jsonp",
      "font/woff2",
      "image/svg+xml",
      "multipart/form-data",
      "",
    ]) {
      assert.equal(textEncoding([{ name: "Content-Type", value }]), undefined, value);
    }
    assert.equal(textEncoding([{ name: "Content-Type" }]), undefined);
    assert.equal(textEncoding(undefined), undefined);
    assert.equal(textEncoding([]), undefined);
    assert.equal(textEncoding([{ name: "Content-Length", value: "2" }]), undefined);
    assert.equal(
      textEncoding([
        { name: "Content-Type", value: "text/plain" },
        { name: "content-type", value: "text/plain" },
      ]),
      undefined,
    );
  });

  it("reads the charset, quoted or not, and falls back to UTF-8 for an unknown one", () => {
    const of = (value: string) => textEncoding([{ name: "Content-Type", value }]);
    assert.equal(of("text/plain; charset=iso-8859-1"), "windows-1252");
    assert.equal(of('text/plain; CharSet="EUC-JP"'), "euc-jp");
    assert.equal(of("text/plain;format=flowed; charset = koi8-r"), "koi8-r");
    assert.equal(of("text/plain; charset=no-such-charset"), "utf-8");
    assert.equal(of("text/plain; charset"), "utf-8");
    assert.equal(of("text/plain; charset="), "utf-8");
    assert.equal(of("text/plain; format=flowed"), "utf-8");
    // A quote at one end only is part of the label.
    assert.equal(of('text/plain; charset="latin1x'), "utf-8");
    assert.equal(of("text/plain; charsetkoi8-r"), "utf-8");
  });

  it("refuses a charset whose decoder is not ASCII-compatible", () => {
    const of = (value: string) => textEncoding([{ name: "Content-Type", value }]);
    assert.equal(of("application/json; charset=utf-16"), undefined);
    assert.equal(of("text/plain; charset=UTF-16LE"), undefined);
    assert.equal(of('text/plain; charset="utf-16be"'), undefined);
    assert.equal(of("text/html; charset=iso-2022-jp"), undefined);
    for (const label of ["Shift_JIS", "gbk", "gb18030", "big5", "euc-kr"]) {
      assert.equal(of(`application/json; charset=${label}`), undefined, label);
    }
  });
});

describe("responseBody", () => {
  it("decodes in the given encoding, with a broken end as U+FFFD", () => {
    assert.deepEqual(responseBody([bytes("café")], "utf-8", false), { text: "café" });
    assert.deepEqual(responseBody([new Uint8Array([0x63, 0xe9])], "windows-1252", false), {
      text: "cé",
    });
    assert.deepEqual(responseBody([new Uint8Array([0x61, 0xc3])], "utf-8", false), {
      text: "a�",
    });
    assert.deepEqual(responseBody([], "utf-8", false), { text: "" });
  });

  it("joins a character split across chunks, and drops one the byte cut split", () => {
    const [first = 0, second = 0] = bytes("é");
    assert.deepEqual(
      responseBody([new Uint8Array([0x61, first]), new Uint8Array([second])], "utf-8", false),
      { text: "aé" },
    );
    assert.deepEqual(responseBody([new Uint8Array([0x61, first])], "utf-8", true), {
      text: "a",
      truncated: true,
    });
  });

  it("cuts the text to the cap, marked truncated, and keeps a body at the cap whole", () => {
    const whole = "a".repeat(MAX_NETWORK_RESPONSE_TEXT);
    assert.deepEqual(responseBody([bytes(whole)], "utf-8", false), { text: whole });
    assert.deepEqual(responseBody([bytes(`${whole}b`)], "utf-8", false), {
      text: whole,
      truncated: true,
    });
  });

  it("refuses UTF-16 text, by its byte order mark or by NULs between ASCII", () => {
    assert.equal(responseBody([new Uint8Array([0xff, 0xfe, 0x61, 0])], "utf-8", false), undefined);
    assert.equal(
      responseBody([new Uint8Array([0xfe]), new Uint8Array([0xff])], "utf-8", false),
      undefined,
    );
    assert.equal(responseBody([new Uint8Array([0x61, 0, 0x62, 0])], "utf-8", false), undefined);
    assert.deepEqual(responseBody([new Uint8Array([0xfe, 0x61])], "windows-1252", false), {
      text: "þa",
    });
    assert.deepEqual(responseBody([new Uint8Array([0xff, 0x61])], "windows-1252", false), {
      text: "\u00ffa",
    });
    assert.deepEqual(responseBody([new Uint8Array([0x61, 0xfe])], "windows-1252", false), {
      text: "a\u00fe",
    });
  });

  it("redacts before the cut, so a token across it is gone", () => {
    const before = "a".repeat(MAX_NETWORK_RESPONSE_TEXT - 12);
    const body = responseBody([bytes(`${before} ${TOKEN} end`)], "utf-8", false);
    assert.deepEqual(body, { text: `${before} ${REDACTED} `, truncated: true });
  });
});

describe("redactTokens", () => {
  it("redacts the token fields of JSON, keeping the keys and quotes", () => {
    assert.equal(
      redactTokens(
        '{"access_token":"a1","refresh_token" : "r1","id_token": "i1","token_type":"Bearer"}',
      ),
      `{"access_token":"${REDACTED}","refresh_token" : "${REDACTED}","id_token": "${REDACTED}","token_type":"Bearer"}`,
    );
    assert.equal(
      redactTokens('{"accessToken":"a\\"1","RefreshToken":"r\\\\","idToken":"i1","n":"x"}'),
      `{"accessToken":"${REDACTED}","RefreshToken":"${REDACTED}","idToken":"${REDACTED}","n":"x"}`,
    );
    assert.equal(
      redactTokens(`{oauth_access_token: 'a1', 'x-refresh-token':'r1', accessToken = "s"}`),
      `{oauth_access_token: '${REDACTED}', 'x-refresh-token':'${REDACTED}', accessToken = "${REDACTED}"}`,
    );
    assert.equal(redactTokens('{"access_token":""}'), '{"access_token":""}');
  });

  it("redacts token fields of form text, query strings and XML elements", () => {
    assert.equal(
      redactTokens("access_token=a1&token_type=bearer&refresh_token=r%2F1 id_token=i1"),
      `access_token=${REDACTED}&token_type=bearer&refresh_token=${REDACTED} id_token=${REDACTED}`,
    );
    assert.equal(
      redactTokens('<a href="/cb#access_token=a1&state=s">'),
      `<a href="/cb#access_token=${REDACTED}&state=s">`,
    );
    assert.equal(
      redactTokens("<r><Access_Token>a1</Access_Token><idToken>i1</idToken><n>x</n></r>"),
      `<r><Access_Token>${REDACTED}</Access_Token><idToken>${REDACTED}</idToken><n>x</n></r>`,
    );
    assert.equal(
      redactTokens("<id_token><![CDATA[i1]]></id_token><access_token>a]1</access_token>"),
      `<id_token><![CDATA[${REDACTED}]]></id_token><access_token>${REDACTED}</access_token>`,
    );
    assert.equal(
      redactTokens("<r>\n  <access_token >\n    <![CDATA[a1]]>\n  </access_token>\n</r>"),
      `<r>\n  <access_token >\n    <![CDATA[${REDACTED}]]>\n  </access_token>\n</r>`,
    );
    assert.equal(redactTokens("<id_token> <![CDATA[i1"), `<id_token> <![CDATA[${REDACTED}`);
  });

  it("leaves names that only end like a token name, and other names", () => {
    for (const text of [
      "paid_token=x",
      '{"paidToken":"x"}',
      '{"token":"x","session":"y","access_token_expires_in":"3600"}',
      "<access_tokens>x</access_tokens>",
      "access_token: none",
    ]) {
      assert.equal(redactTokens(text), text);
    }
  });

  it("redacts JWT-shaped strings anywhere, also with an empty or a fifth segment", () => {
    assert.equal(redactTokens(`Bearer ${TOKEN}!`), `Bearer ${REDACTED}!`);
    assert.equal(redactTokens('{"t":"eyJhbGc.eyJzdWI."}'), `{"t":"${REDACTED}"}`);
    assert.equal(redactTokens("eyJa.b.c.d.e"), REDACTED);
    assert.equal(redactTokens("eyJa.b.c.d.e.f"), `${REDACTED}.f`);
    assert.equal(redactTokens("xeyJa.b.c is not one"), "xeyJa.b.c is not one");
    assert.equal(redactTokens("abc_eyJa.b"), "abc_eyJa.b");
    assert.equal(redactTokens("eyJabc in a sentence"), "eyJabc in a sentence");
    assert.equal(redactTokens(`?auth=Bearer%20${TOKEN}`), `?auth=Bearer%20${REDACTED}`);
    assert.equal(redactTokens("?t%3DeyJa.b.c.d.e&x"), `?t%3D${REDACTED}&x`);
    assert.equal(redactTokens("%2eyJa.b"), "%2eyJa.b");
  });

  it("redacts a token the text ends inside", () => {
    assert.equal(redactTokens('{"access_token":"a1b2'), `{"access_token":"${REDACTED}`);
    assert.equal(redactTokens("{'id_token': 'i1\\"), `{'id_token': '${REDACTED}`);
    assert.equal(redactTokens("access_token=a1"), `access_token=${REDACTED}`);
    assert.equal(redactTokens("<id_token>i1"), `<id_token>${REDACTED}`);
    assert.equal(redactTokens("<id_token><![CDATA[i1"), `<id_token><![CDATA[${REDACTED}`);
    assert.equal(redactTokens('{"t":"eyJhbGciOiJIUz'), `{"t":"${REDACTED}`);
    assert.equal(redactTokens("x eyJhbGciOiJIUz"), `x ${REDACTED}`);
    assert.equal(redactTokens("x%20eyJhbGciOiJIUz"), `x%20${REDACTED}`);
  });

  it("stays fast on long runs of text the patterns could match from every position", () => {
    const size = MAX_NETWORK_RESPONSE_BYTES;
    for (const text of [
      "eyJ".repeat(size / 3),
      `${"eyJ".repeat(size / 3 - 1)}!`,
      `${"eyJ.".repeat(size / 4 - 1)}!`,
      `${"%20eyJ".repeat(size / 6 - 1)}!`,
      `%20${"eyJ".repeat(size / 3 - 1)}!`,
      '"access_token":"'.repeat(size / 16),
      '"access_token":\''.repeat(size / 16),
      `${"a".repeat(size - 13)}access_token=`,
      `${"a".repeat(size - 13)}access_token:`,
      "<access_token>".repeat(size / 14),
      `<access_token>${"]".repeat(size - 14)}`,
      "<access_token><![CDATA[".repeat(size / 23),
      `<access_token${" ".repeat(size - 14)}`,
      `<access_token>${" ".repeat(size - 15)}<`,
      "\\".repeat(size),
      `"access_token":"${"\\".repeat(size - 16)}`,
      `access_token=${"a".repeat(size - 13)}`,
    ]) {
      const started = performance.now();
      redactTokens(text);
      const took = performance.now() - started;
      assert.ok(took < 100, `${took} ms on ${text.slice(0, 20)}`);
    }
  });
});

describe("captureResponse", () => {
  it("passes every chunk on before it copies it, and stores the text at the stop", () => {
    const { filter, capture, stored, ends } = captured();
    const [first = 0, second = 0] = bytes("\u00e9");
    filter.data(new Uint8Array([0x7b, 0x22, first]));
    filter.data(new Uint8Array([second, 0x22, 0x3a]));
    filter.data("true}");
    assert.equal(filter.writtenText(), '{"\u00e9":true}');
    capture.headers(JSON_TYPE);
    assert.deepEqual(stored, []);
    filter.stop();
    assert.equal(filter.closes, 1);
    assert.deepEqual(stored, [{ text: '{"\u00e9":true}' }]);
    assert.equal(ends.count, 1);
    assert.equal(filter.disconnects, 0);
  });

  it("stores once the headers come after the stop", () => {
    const { filter, capture, stored, ends } = captured();
    filter.data("hello");
    filter.stop();
    assert.deepEqual(stored, []);
    assert.equal(ends.count, 0);
    capture.headers([{ name: "Content-Type", value: "text/plain" }]);
    assert.deepEqual(stored, [{ text: "hello" }]);
    capture.headers([{ name: "Content-Type", value: "image/png" }]);
    assert.equal(ends.count, 1);
  });

  it("stores the text when the close at the stop throws", () => {
    const { filter, capture, stored } = captured();
    capture.headers(JSON_TYPE);
    filter.data("{}");
    filter.close = () => {
      throw new Error("NS_ERROR_FAILURE");
    };
    filter.stop();
    assert.deepEqual(stored, [{ text: "{}" }]);
    assert.equal(filter.status, "finishedtransferringdata");
    filter.data("late");
    assert.equal(filter.writtenText(), "{}");
  });

  it("keeps the type it read when later headers have none", () => {
    const { filter, capture, stored } = captured();
    capture.headers(JSON_TYPE);
    filter.data("{}");
    // onCompleted can come without headers.
    capture.headers(undefined);
    filter.stop();
    assert.deepEqual(stored, [{ text: "{}" }]);
  });

  it("stores an empty body", () => {
    const { filter, capture, stored } = captured();
    capture.headers(JSON_TYPE);
    filter.stop();
    assert.deepEqual(stored, [{ text: "" }]);
  });

  it("releases a response whose type is not text, and the rest passes uncopied", () => {
    const { filter, capture, stored, ends, hooks } = captured();
    filter.data("GIF89a");
    capture.headers([{ name: "Content-Type", value: "image/gif" }]);
    assert.equal(ends.count, 1);
    filter.data("more");
    filter.stop();
    assert.equal(filter.disconnects, 0);
    assert.equal(filter.writtenText(), "GIF89amore");
    assert.equal(filter.closes, 1);
    assert.equal(hooks.asked, 1);
    assert.deepEqual(stored, []);
    assert.equal(ends.count, 1);
  });

  it("keeps a body of exactly the byte cap whole, and cuts one byte more", () => {
    // Two bytes each, so the byte cap holds exactly the text cap.
    const full = "\u00e9".repeat(MAX_NETWORK_RESPONSE_BYTES / 2);
    assert.equal(full.length, MAX_NETWORK_RESPONSE_TEXT);
    const whole = captured();
    whole.capture.headers(JSON_TYPE);
    whole.filter.data(full.slice(1));
    whole.filter.data("\u00e9");
    assert.equal(whole.filter.disconnects, 0);
    whole.filter.stop();
    assert.deepEqual(whole.stored, [{ text: full }]);

    const over = captured();
    over.capture.headers(JSON_TYPE);
    over.filter.data(full);
    assert.equal(over.filter.disconnects, 0);
    over.filter.data("bc");
    assert.deepEqual(over.stored, [{ text: full, truncated: true }]);
    assert.equal(over.ends.count, 1);
    over.filter.data("de");
    over.filter.stop();
    assert.equal(over.filter.disconnects, 0);
    assert.equal(over.filter.writtenText(), `${full}bcde`);
    assert.equal(over.filter.closes, 1);
    assert.deepEqual(over.stored, [{ text: full, truncated: true }]);
    assert.equal(over.ends.count, 1);
  });

  it("cuts a chunk larger than what is left under the cap and copies no more", () => {
    const { filter, capture, stored, hooks } = captured();
    filter.data("x".repeat(10));
    filter.data("y".repeat(2 * MAX_NETWORK_RESPONSE_BYTES));
    assert.equal(filter.written.at(-1)?.byteLength, 2 * MAX_NETWORK_RESPONSE_BYTES);
    assert.equal(stored.length, 0);
    const asked = hooks.asked;
    filter.data("z");
    assert.equal(hooks.asked, asked);
    assert.equal(filter.written.at(-1)?.byteLength, 1);
    capture.headers([{ name: "Content-Type", value: "text/plain" }]);
    filter.stop();
    assert.equal(filter.disconnects, 0);
    assert.equal(filter.closes, 1);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.truncated, true);
    assert.equal(stored[0]?.text, `${"x".repeat(10)}${"y".repeat(MAX_NETWORK_RESPONSE_TEXT - 10)}`);
  });

  it("drops the copy on an error, ending once", () => {
    const { filter, capture, stored, ends } = captured();
    capture.headers(JSON_TYPE);
    filter.data("{");
    filter.fail("Channel redirected");
    assert.deepEqual(stored, []);
    assert.equal(ends.count, 1);
    assert.equal(filter.error, "Channel redirected");
    filter.data("}");
    assert.equal(filter.writtenText(), "{");
    capture.release();
    capture.check();
    assert.equal(ends.count, 1);
  });

  it("ends the capture when a write throws, writes later chunks on and stores nothing", () => {
    const { filter, capture, stored, ends, hooks } = captured();
    capture.headers(JSON_TYPE);
    filter.failWrite = true;
    filter.data("{}");
    assert.equal(ends.count, 1);
    filter.failWrite = false;
    filter.data("more");
    filter.stop();
    assert.equal(filter.disconnects, 0);
    assert.equal(filter.writtenText(), "more");
    assert.equal(filter.closes, 1);
    assert.equal(hooks.asked, 0);
    assert.equal(ends.count, 1);
    assert.deepEqual(stored, []);
  });

  it("passes the chunk on and copies no more when the copy or a hook throws", () => {
    for (const fault of ["wanted", "store"] as const) {
      const { filter, capture, stored, ends, hooks } = captured();
      capture.headers(JSON_TYPE);
      hooks.fault = fault;
      filter.data("{}");
      if (fault === "wanted") {
        const asked = hooks.asked;
        filter.data("more");
        assert.equal(hooks.asked, asked, fault);
      }
      filter.stop();
      assert.equal(filter.writtenText(), fault === "wanted" ? "{}more" : "{}", fault);
      assert.equal(ends.count, 1, fault);
      assert.deepEqual(stored, [], fault);
      assert.equal(filter.disconnects, 0, fault);
      assert.equal(filter.closes, 1, fault);
    }
  });

  it("ends the capture when the site check throws at the stop", () => {
    const { filter, capture, stored, ends, hooks } = captured();
    capture.headers(JSON_TYPE);
    filter.data("{}");
    hooks.fault = "wanted";
    filter.stop();
    assert.equal(ends.count, 1);
    assert.deepEqual(stored, []);
    assert.equal(filter.disconnects, 0);
    assert.equal(filter.closes, 1);
  });

  it("ends the capture when the headers or a check throw", () => {
    const headers = captured();
    headers.filter.data("{}");
    headers.filter.stop();
    headers.hooks.fault = "wanted";
    headers.capture.headers(JSON_TYPE);
    assert.equal(headers.ends.count, 1);
    assert.deepEqual(headers.stored, []);

    const checked = captured();
    checked.filter.data("{}");
    checked.hooks.fault = "wanted";
    checked.capture.check();
    assert.equal(checked.ends.count, 1);
    const asked = checked.hooks.asked;
    checked.filter.data("more");
    assert.equal(checked.hooks.asked, asked);
    assert.equal(checked.filter.disconnects, 0);
    assert.equal(checked.filter.writtenText(), "{}more");

    const early = captured();
    early.hooks.fault = "wanted";
    early.capture.check();
    assert.equal(early.ends.count, 1);
    early.filter.start();
    assert.equal(early.filter.disconnects, 1);
    assert.equal(early.filter.status, "disconnected");
  });

  it("releases at the next chunk once it is no longer wanted or the answer is unknown", () => {
    for (const answer of ["no", "unknown"] as const) {
      const { filter, capture, stored, ends, hooks } = captured();
      capture.headers(JSON_TYPE);
      filter.data("{");
      hooks.answer = answer;
      filter.data("}");
      assert.equal(filter.writtenText(), "{}", answer);
      assert.equal(ends.count, 1, answer);
      hooks.answer = "yes";
      filter.data("more");
      filter.stop();
      assert.equal(filter.disconnects, 0, answer);
      assert.equal(filter.writtenText(), "{}more", answer);
      assert.equal(filter.closes, 1, answer);
      assert.deepEqual(stored, [], answer);
      assert.equal(ends.count, 1, answer);
    }
  });

  it("waits at the stop while the answer is unknown, then stores or releases at a check", () => {
    const yes = captured();
    yes.capture.headers(JSON_TYPE);
    yes.filter.data("{}");
    yes.hooks.answer = "unknown";
    yes.filter.stop();
    assert.deepEqual(yes.stored, []);
    yes.capture.check();
    assert.deepEqual(yes.stored, []);
    yes.hooks.answer = "yes";
    yes.capture.check();
    assert.deepEqual(yes.stored, [{ text: "{}" }]);
    assert.equal(yes.ends.count, 1);

    const no = captured();
    no.capture.headers(JSON_TYPE);
    no.filter.data("{}");
    no.hooks.answer = "unknown";
    no.filter.stop();
    no.hooks.answer = "no";
    no.capture.check();
    assert.deepEqual(no.stored, []);
    assert.equal(no.ends.count, 1);
  });

  it("releases at the stop when it is no longer wanted", () => {
    const { filter, capture, stored, ends, hooks } = captured();
    capture.headers(JSON_TYPE);
    filter.data("{}");
    hooks.answer = "no";
    filter.stop();
    assert.equal(filter.closes, 1);
    assert.deepEqual(stored, []);
    assert.equal(ends.count, 1);
  });

  it("disconnects at the start when released before it, and passes everything on", () => {
    const { filter, capture, ends } = captured();
    capture.release();
    assert.equal(ends.count, 1);
    assert.equal(filter.disconnects, 0);
    filter.start();
    assert.equal(filter.disconnects, 1);
    assert.equal(filter.status, "disconnected");
  });

  it("never disconnects once the response started, and writes every later chunk on in order", () => {
    const over = "x".repeat(MAX_NETWORK_RESPONSE_BYTES + 1);
    const ways: Record<string, (made: ReturnType<typeof captured>) => string> = {
      headers: ({ filter, capture }) => {
        filter.data("a");
        capture.headers([{ name: "Content-Type", value: "image/gif" }]);
        return "a";
      },
      check: ({ filter, capture, hooks }) => {
        filter.data("a");
        hooks.answer = "no";
        capture.check();
        return "a";
      },
      release: ({ filter, capture }) => {
        filter.data("a");
        capture.release();
        return "a";
      },
      cap: ({ filter, capture }) => {
        capture.headers(JSON_TYPE);
        filter.data(over);
        return over;
      },
      fault: ({ filter, capture, hooks }) => {
        capture.headers(JSON_TYPE);
        hooks.fault = "wanted";
        filter.data("a");
        return "a";
      },
    };
    for (const [way, end] of Object.entries(ways)) {
      const made = captured();
      const first = end(made);
      assert.equal(made.ends.count, 1, way);
      for (const chunk of ["b", "c", "d"]) made.filter.data(chunk);
      made.filter.stop();
      assert.equal(made.filter.disconnects, 0, way);
      assert.equal(made.filter.writtenText(), `${first}bcd`, way);
      assert.equal(made.filter.closes, 1, way);
      assert.equal(made.ends.count, 1, way);
    }
  });

  it("holds nothing of a capture that ended while the rest of its response passes", async () => {
    const { filter, hooks } = releasedAfterTheStart();
    // A WeakRef keeps its target until the job that made it is over.
    await new Promise((resolve) => setImmediate(resolve));
    collectGarbage();
    assert.equal(hooks.deref(), undefined);
    filter.data("b");
    filter.stop();
    assert.equal(filter.writtenText(), "ab");
    assert.equal(filter.closes, 1);
    assert.equal(filter.disconnects, 0);
  });

  it("keeps writing and closes at the stop when no disconnect works", () => {
    const { filter, capture, hooks } = captured();
    capture.release();
    filter.disconnect = () => {
      throw new Error("NS_ERROR_FAILURE");
    };
    filter.data("a");
    filter.data("b");
    filter.stop();
    assert.equal(filter.writtenText(), "ab");
    assert.equal(filter.closes, 1);
    // Nothing more is copied once the capture ended.
    assert.equal(hooks.asked, 0);
  });

  it("ignores headers, checks and releases after it ended", () => {
    const { filter, capture, stored, ends } = captured();
    capture.headers(JSON_TYPE);
    filter.stop();
    capture.headers([{ name: "Content-Type", value: "image/png" }]);
    capture.check();
    capture.release();
    assert.deepEqual(stored, [{ text: "" }]);
    assert.equal(ends.count, 1);
    assert.equal(filter.disconnects, 0);
  });

  it("redacts the stored text", () => {
    const { filter, capture, stored } = captured();
    capture.headers(JSON_TYPE);
    filter.data(`{"access_token":"secret","id":"${TOKEN}"}`);
    filter.stop();
    assert.deepEqual(stored, [{ text: `{"access_token":"${REDACTED}","id":"${REDACTED}"}` }]);
  });

  it("redacts a token the byte cut leaves unfinished", () => {
    const { filter, capture, stored } = captured();
    capture.headers(JSON_TYPE);
    // 65,487 bytes in 32,757 characters: the cut falls inside the value, within the text cap.
    const before = `{"pad":"${"\u00e9".repeat(32_730)}","refresh_token":"`;
    filter.data(`${before}${"r1".repeat(50)}"}`);
    assert.equal(filter.disconnects, 0);
    assert.deepEqual(stored, [{ text: `${before}${REDACTED}`, truncated: true }]);
  });

  it("refuses a body that starts with a UTF-16 byte order mark", () => {
    const { filter, capture, stored, ends } = captured();
    capture.headers(JSON_TYPE);
    filter.data(new Uint8Array([0xff, 0xfe, 0x7b, 0, 0x7d, 0]));
    filter.stop();
    assert.deepEqual(stored, []);
    assert.equal(ends.count, 1);
  });
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface Hooks {
  answer: Wanted;
  fault: "wanted" | "store" | undefined;
  /** How often `wanted` ran. */
  asked: number;
}

/** A capture released after its first chunk, with nothing but a weak reference to its hooks. */
function releasedAfterTheStart(): { filter: FakeStreamFilter; hooks: WeakRef<CaptureHooks> } {
  const fake = createFakeBrowser();
  fake.browser.webRequest.filterResponseData("r1");
  const filter = fake.streamFilters[0];
  assert.ok(filter !== undefined);
  const hooks: CaptureHooks = { wanted: () => "yes", store: () => undefined, end: () => undefined };
  const capture = captureResponse(filter, hooks);
  filter.data("a");
  capture.release();
  return { filter, hooks: new WeakRef(hooks) };
}

/** Runs V8's garbage collector, which Node exposes only behind a flag. */
function collectGarbage(): void {
  setFlagsFromString("--expose-gc");
  (runInNewContext("gc") as () => void)();
}

/** A capture on a fresh fake filter, with hooks a test steers. */
function captured(): {
  filter: FakeStreamFilter;
  capture: ResponseCapture;
  stored: NetworkResponseBody[];
  ends: { count: number };
  hooks: Hooks;
} {
  const fake = createFakeBrowser();
  const filter = fake.browser.webRequest.filterResponseData("r1");
  const made = fake.streamFilters[0];
  assert.ok(made !== undefined && made === filter);
  const stored: NetworkResponseBody[] = [];
  const ends = { count: 0 };
  const hooks: Hooks = { answer: "yes", fault: undefined, asked: 0 };
  const capture = captureResponse(made, {
    wanted: () => {
      hooks.asked += 1;
      if (hooks.fault === "wanted") throw new Error("wanted");
      return hooks.answer;
    },
    store: (body) => {
      if (hooks.fault === "store") throw new Error("store");
      stored.push(body);
    },
    end: () => {
      ends.count += 1;
    },
  });
  return { filter: made, capture, stored, ends, hooks };
}
