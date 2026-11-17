import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_NETWORK_BODY_FIELDS,
  NETWORK_BODY_NAME_WITHHELD,
  type NetworkBody,
  type NetworkBodyField,
} from "@foxleash/protocol";
import type { RequestBody } from "./browser-api.ts";
import { bodyShape } from "./request-body.ts";

const WITHHELD = NETWORK_BODY_NAME_WITHHELD;
const SHOWN_NAMES = [
  "username",
  "g-recaptcha-response",
  "user[password]",
  "items[]",
  "__VIEWSTATE",
  "ctl00$Main$txtName",
  "a.b:c",
  `n${"x".repeat(99)}`,
];
const WITHHELD_NAMES = [
  "a@b.example",
  "123456",
  "1a",
  "First name",
  "förnamn",
  "$schema",
  "-a",
  "",
  `n${"x".repeat(100)}`,
];

describe("bodyShape", () => {
  it("gives no shape for a request that sent no body", () => {
    assert.equal(bodyShape(null), undefined);
    assert.equal(bodyShape(undefined), undefined);
  });

  it("lists a form's fields in order with whether each is filled, never a value", () => {
    assert.deepEqual(
      shapeOf({ formData: { username: ["alice-Kq3"], password: [""] } }, ["alice-Kq3"]),
      { kind: "form", fields: [text("username", true), text("password", false)] },
    );
  });

  it("lists a repeated name once, filled by its first value", () => {
    assert.deepEqual(
      shapeOf({ formData: { tag: ["red-Vb1", "", "blue-Vb2"], note: ["note-Vb3"] } }, [
        "red-Vb1",
        "blue-Vb2",
        "note-Vb3",
      ]),
      { kind: "form", fields: [text("tag", true), text("note", true)] },
    );
    assert.deepEqual(shapeOf({ formData: { tag: ["", "red-Vb4"] } }, ["red-Vb4"]), {
      kind: "form",
      fields: [text("tag", false)],
    });
  });

  it("lists an array sent as a form or as indexed keys by its first element only", () => {
    const bytes = [...new TextEncoder().encode("hunter-Ix1")].map(String);
    const secrets = ["hunter", "104", '"pw[1]"', '"items[1]'];
    assert.deepEqual(shapeOf({ formData: { "pw[]": bytes, ok: ["1"] } }, secrets), {
      kind: "form",
      fields: [text("pw[]", true), text("ok", true)],
    });
    const indexed = Object.fromEntries(bytes.map((byte, index) => [`pw[${index}]`, [byte]]));
    assert.deepEqual(shapeOf({ formData: { ...indexed, "pw[]": ["1"], ok: ["1"] } }, secrets), {
      kind: "form",
      fields: [text("pw[0]", true), text("ok", true)],
    });
    const items = {
      "items[0][name]": ["a"],
      "items[0][qty]": [""],
      "items[1][name]": ["b"],
      "items[12][qty]": ["2"],
      "items[x]": ["c"],
    };
    assert.deepEqual(shapeOf({ formData: items }, secrets), {
      kind: "form",
      fields: [text("items[0][name]", true), text("items[0][qty]", false), text("items[x]", true)],
    });
    // An index that makes the name too long to show is still the same array's.
    const long = "p".repeat(97);
    const eleven = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`${long}[${index}]`, [index === 10 ? "" : "x"]]),
    );
    assert.deepEqual(shapeOf({ formData: eleven }, secrets), {
      kind: "form",
      fields: [text(`${long}[0]`, true)],
    });
    assert.deepEqual(shapeOf({ formData: { ...eleven, "x@a.example": ["v-Ix2"] } }, ["v-Ix2"]), {
      kind: "form",
      fields: [text(`${long}[0]`, true), text(WITHHELD, true)],
    });
    const elevenKeys = Object.fromEntries(Object.keys(eleven).map((key) => [key, 1]));
    assert.deepEqual(shapeOf(raw(JSON.stringify(elevenKeys)), secrets), {
      kind: "json",
      fields: [{ name: `${long}[0]`, depth: 1, kind: "number" }],
    });
    const keys = Object.fromEntries(bytes.map((byte, index) => [`pw[${index}]`, Number(byte)]));
    assert.deepEqual(shapeOf(raw(JSON.stringify({ ...keys, ok: true })), secrets), {
      kind: "json",
      fields: [
        { name: "pw[0]", depth: 1, kind: "number" },
        { name: "ok", depth: 1, kind: "boolean" },
      ],
    });
  });

  it("shows a multipart file field as text, filled when the file has a name", () => {
    assert.deepEqual(
      shapeOf({ formData: { upload: ["holiday-Wq8.jpg"], other: [""] } }, ["holiday-Wq8"]),
      { kind: "form", fields: [text("upload", true), text("other", false)] },
    );
  });

  it("gives body text that is not a form, whatever its content type, as other", () => {
    const bodies: [RequestBody, string[]][] = [
      // JSON posted as a form: no `=`, so the whole text is a name with an undefined value.
      [
        { formData: { '{"username":"alice-Hn4","password":"hunter-Hn5"}': [undefined] } },
        ["alice-Hn4", "hunter-Hn5"],
      ],
      [{ formData: { "token-Hn6": [undefined] } }, ["token-Hn6"]],
      [{ formData: { a: ["1"], "token-Hn7": [undefined] } }, ["token-Hn7"]],
      // JSON holding an `=`: split there, the name still starts with `{`.
      [{ formData: { '{"code":"x': ['y-Hn8"}'] } }, ["y-Hn8"]],
      [{ formData: { '  ["list-Hn9"': ["1"] } }, ["list-Hn9"]],
      [{ formData: { ok: ["1"], '[{"a":"b': ['c-Hm1"}]'] } }, ["c-Hm1"]],
      // A base64 token with `=` padding, also followed by a line break.
      [{ formData: { YWxpY2U6aHVudGVyMjI: [""] } }, ["YWxpY2U6aHVudGVyMjI"]],
      [{ formData: { YWxpY2U6aHVudGVyMjM: ["\r\n"] } }, ["YWxpY2U6aHVudGVyMjM"]],
      [{ formData: { q: [" "] } }, []],
      [{ formData: { "": [undefined], "secret-Hm2": [""] } }, ["secret-Hm2"]],
      [{ formData: { q: [""] } }, []],
    ];
    for (const [body, secrets] of bodies) {
      assert.deepEqual(shapeOf(body, secrets), { kind: "other" }, JSON.stringify(body));
    }
  });

  it("leaves out Firefox's empty name of an empty part, and withholds an empty name with a value", () => {
    assert.deepEqual(shapeOf({ formData: { "": [undefined, undefined], a: ["val-Pt1"] } }, []), {
      kind: "form",
      fields: [text("a", true)],
    });
    assert.deepEqual(shapeOf({ formData: { "": [undefined] } }, []), { kind: "form", fields: [] });
    assert.deepEqual(shapeOf({ formData: { "": ["val-Pt2"], a: ["1"] } }, ["val-Pt2"]), {
      kind: "form",
      fields: [text(WITHHELD, true), text("a", true)],
    });
    // A single empty-valued field next to a skipped empty part is still not a form.
    assert.deepEqual(shapeOf({ formData: { "": [undefined], q: [""] } }, []), { kind: "other" });
    assert.deepEqual(shapeOf({ formData: { q: ["", ""] } }, []), {
      kind: "form",
      fields: [text("q", false)],
    });
    // A name with no values, which Firefox does not give, is left out.
    assert.deepEqual(
      shapeOf({ formData: { "x@a.example": [], "y@a.example": ["v-Pt3"], ok: [] } }, ["v-Pt3"]),
      { kind: "form", fields: [text(WITHHELD, true)] },
    );
    assert.deepEqual(shapeOf({ formData: { ok: [], q: [""] } }, []), { kind: "other" });
    assert.deepEqual(shapeOf({ formData: { q: [""], r: [""] } }, []), {
      kind: "form",
      fields: [text("q", false), text("r", false)],
    });
    assert.deepEqual(shapeOf({ formData: { q: [" "], r: ["\n"] } }, []), {
      kind: "form",
      fields: [text("q", true), text("r", true)],
    });
  });

  it("lists at most 100 form fields, marking the shape truncated only when more were left out", () => {
    const names = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, ["v", "w"]]));
    const exact = shapeOf({ formData: names(MAX_NETWORK_BODY_FIELDS) }, []);
    assert.deepEqual(exact, {
      kind: "form",
      fields: Array.from({ length: MAX_NETWORK_BODY_FIELDS }, (_, index) =>
        text(`f${index}`, true),
      ),
    });
    const shape = shapeOf({ formData: names(MAX_NETWORK_BODY_FIELDS + 1) }, []);
    assert.equal(shape?.fields?.length, MAX_NETWORK_BODY_FIELDS);
    assert.equal(shape?.fields?.at(-1)?.name, `f${MAX_NETWORK_BODY_FIELDS - 1}`);
    assert.equal(shape?.truncated, true);
  });

  it("shows plain form names and withholds the rest, all in one field at the first", () => {
    for (const name of SHOWN_NAMES) {
      assert.deepEqual(shapeOf({ formData: { [name]: ["v-Lk1"] } }, ["v-Lk1"]), {
        kind: "form",
        fields: [text(name, true)],
      });
    }
    for (const name of WITHHELD_NAMES) {
      assert.deepEqual(
        shapeOf({ formData: { [name]: ["v-Lk2"], ok: ["1"] } }, ["v-Lk2", ...nonEmpty(name)]),
        { kind: "form", fields: [text(WITHHELD, true), text("ok", true)] },
        name,
      );
    }
    assert.deepEqual(
      shapeOf(
        {
          formData: {
            "first@a.example": ["", "v-Lk3"],
            ok: ["1"],
            "second@a.example": ["v-Lk4"],
            "third name": ["v-Lk5", "v-Lk6"],
          },
        },
        ["first@", "second@", "third name", "v-Lk3", "v-Lk4", "v-Lk5", "v-Lk6"],
      ),
      { kind: "form", fields: [text(WITHHELD, false), text("ok", true)] },
    );
    assert.deepEqual(
      shapeOf({ formData: { "first@a.example": ["v-Lk7"], "second name": ["", "v-Lk8"] } }, [
        "first@",
        "second name",
        "v-Lk7",
        "v-Lk8",
      ]),
      { kind: "form", fields: [text(WITHHELD, true)] },
    );
  });

  it("counts only the one withheld form field toward the cap", () => {
    const formData: Record<string, string[]> = { "x@a.example": ["1"] };
    for (let index = 0; index < MAX_NETWORK_BODY_FIELDS - 1; index += 1) {
      formData[`f${index}`] = ["1"];
    }
    for (let index = 0; index < 50; index += 1) formData[`y${index}@a.example`] = ["1"];
    const shape = shapeOf({ formData }, ["@a.example"]);
    assert.equal(shape?.fields?.length, MAX_NETWORK_BODY_FIELDS);
    assert.equal(shape?.fields?.[0]?.name, WITHHELD);
    assert.equal(shape?.truncated, undefined);
  });

  it("lists a JSON object's keys with each value's kind and whether it is filled", () => {
    const body = {
      username: "alice-Js1",
      empty: "",
      age: 42,
      remember: true,
      middle: null,
      profile: { city: "town-Js2", none: {} },
    };
    assert.deepEqual(shapeOf(raw(JSON.stringify(body)), ["alice-Js1", "42", "town-Js2"]), {
      kind: "json",
      fields: [
        { name: "username", depth: 1, kind: "string", filled: true },
        { name: "empty", depth: 1, kind: "string", filled: false },
        { name: "age", depth: 1, kind: "number" },
        { name: "remember", depth: 1, kind: "boolean" },
        { name: "middle", depth: 1, kind: "null" },
        { name: "profile", depth: 1, kind: "object", filled: true },
        { name: "city", depth: 2, kind: "string", filled: true },
        { name: "none", depth: 2, kind: "object", filled: false },
      ],
    });
  });

  it("lists only an array's first element, as [], with its own keys", () => {
    const body = {
      list: [{ id: "first-Ar1", tags: ["tag-Ar2", "tag-Ar3"] }, { id: "second-Ar4" }],
      empty: [],
    };
    assert.deepEqual(shapeOf(raw(JSON.stringify(body)), ["first-Ar1", "tag-Ar", "second-Ar4"]), {
      kind: "json",
      fields: [
        { name: "list", depth: 1, kind: "array", filled: true },
        { name: "[]", depth: 2, kind: "object", filled: true },
        { name: "id", depth: 3, kind: "string", filled: true },
        { name: "tags", depth: 3, kind: "array", filled: true },
        { name: "[]", depth: 4, kind: "string", filled: true },
        { name: "empty", depth: 1, kind: "array", filled: false },
      ],
    });
    assert.deepEqual(shapeOf(raw('["a-Ar5", "b-Ar6"]'), ["a-Ar5", "b-Ar6"]), {
      kind: "json",
      fields: [{ name: "[]", depth: 1, kind: "string", filled: true }],
    });
    assert.deepEqual(shapeOf(raw("[]"), []), { kind: "json", fields: [] });
    assert.deepEqual(shapeOf(raw("{}"), []), { kind: "json", fields: [] });
  });

  it("applies the name rule to JSON keys, with one withheld field per object", () => {
    for (const name of [...SHOWN_NAMES]) {
      assert.deepEqual(shapeOf(raw(JSON.stringify({ [name]: 1 })), []), {
        kind: "json",
        fields: [{ name, depth: 1, kind: "number" }],
      });
    }
    for (const name of [...WITHHELD_NAMES, "[]"]) {
      assert.deepEqual(
        shapeOf(raw(JSON.stringify({ [name]: "v-Jk1", ok: 1 })), ["v-Jk1", ...nonEmpty(name)]),
        {
          kind: "json",
          fields: [
            { name: WITHHELD, depth: 1, kind: "string", filled: true },
            { name: "ok", depth: 1, kind: "number" },
          ],
        },
        name,
      );
    }
    const body = {
      "first@a.example": "v-Jk2",
      plain: 1,
      "second@a.example": { inner: "v-Jk3" },
      nested: { "x@a.example": true, "y@a.example": "v-Jk4" },
    };
    assert.deepEqual(
      shapeOf(raw(JSON.stringify(body)), ["@a.example", "v-Jk2", "inner", "v-Jk3", "v-Jk4"]),
      {
        kind: "json",
        fields: [
          { name: WITHHELD, depth: 1, kind: "string", filled: true },
          { name: "plain", depth: 1, kind: "number" },
          { name: "nested", depth: 1, kind: "object", filled: true },
          { name: WITHHELD, depth: 2, kind: "boolean" },
        ],
      },
    );
  });

  it("gives a byte array sent as an object of indices one withheld field", () => {
    const bytes = Object.fromEntries([...new TextEncoder().encode("hunter-B2")].entries());
    assert.deepEqual(shapeOf(raw(JSON.stringify({ pw: bytes })), ["hunter", "104"]), {
      kind: "json",
      fields: [
        { name: "pw", depth: 1, kind: "object", filled: true },
        { name: WITHHELD, depth: 2, kind: "number" },
      ],
    });
  });

  it("lists keys four deep, marking the shape truncated when a deeper one is left out", () => {
    assert.deepEqual(shapeOf(raw('{"a":{"b":{"c":{"d":{"e":"v-Dp1"}}}}}'), ["v-Dp1", '"e"']), {
      kind: "json",
      fields: [
        { name: "a", depth: 1, kind: "object", filled: true },
        { name: "b", depth: 2, kind: "object", filled: true },
        { name: "c", depth: 3, kind: "object", filled: true },
        { name: "d", depth: 4, kind: "object", filled: true },
      ],
      truncated: true,
    });
    assert.deepEqual(shapeOf(raw('{"a":{"b":{"c":{"d":{},"e":[]}}}}'), []), {
      kind: "json",
      fields: [
        { name: "a", depth: 1, kind: "object", filled: true },
        { name: "b", depth: 2, kind: "object", filled: true },
        { name: "c", depth: 3, kind: "object", filled: true },
        { name: "d", depth: 4, kind: "object", filled: false },
        { name: "e", depth: 4, kind: "array", filled: false },
      ],
    });
    assert.deepEqual(shapeOf(raw('{"a":{"b":{"c":{"d":"v-Dp2"}}}}'), ["v-Dp2"]), {
      kind: "json",
      fields: [
        { name: "a", depth: 1, kind: "object", filled: true },
        { name: "b", depth: 2, kind: "object", filled: true },
        { name: "c", depth: 3, kind: "object", filled: true },
        { name: "d", depth: 4, kind: "string", filled: true },
      ],
    });
    assert.deepEqual(shapeOf(raw("[[[[[1]]]]]"), []), {
      kind: "json",
      fields: [1, 2, 3, 4].map((depth) => ({ name: "[]", depth, kind: "array", filled: true })),
      truncated: true,
    });
  });

  it("chooses fields shallowest first and lists each followed by its children", () => {
    const data = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`k${index}`, 1]));
    assert.deepEqual(
      shapeOf(raw(JSON.stringify({ data, "g-recaptcha-response": "token-Bf1" })), ["token-Bf1"]),
      {
        kind: "json",
        fields: [
          { name: "data", depth: 1, kind: "object", filled: true },
          ...Array.from({ length: 98 }, (_, index) => ({
            name: `k${index}`,
            depth: 2,
            kind: "number" as const,
          })),
          { name: "g-recaptcha-response", depth: 1, kind: "string", filled: true },
        ],
        truncated: true,
      },
    );
    assert.deepEqual(shapeOf(raw('{"a":{"x":1},"b":{"y":{"z":2}}}'), []), {
      kind: "json",
      fields: [
        { name: "a", depth: 1, kind: "object", filled: true },
        { name: "x", depth: 2, kind: "number" },
        { name: "b", depth: 1, kind: "object", filled: true },
        { name: "y", depth: 2, kind: "object", filled: true },
        { name: "z", depth: 3, kind: "number" },
      ],
    });
  });

  it("is not truncated at exactly 100 JSON fields", () => {
    const keys = (count: number) =>
      JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 1])));
    const exact = shapeOf(raw(keys(MAX_NETWORK_BODY_FIELDS)), []);
    assert.equal(exact?.fields?.length, MAX_NETWORK_BODY_FIELDS);
    assert.equal(exact?.truncated, undefined);
    const over = shapeOf(raw(keys(MAX_NETWORK_BODY_FIELDS + 1)), []);
    assert.equal(over?.fields?.length, MAX_NETWORK_BODY_FIELDS);
    assert.equal(over?.truncated, true);
    // The 100th field is a filled container: its entries are left out by the cap.
    const filled = JSON.stringify({
      ...Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`k${i}`, 1])),
      last: { x: 1 },
    });
    const capped = shapeOf(raw(filled), []);
    assert.equal(capped?.fields?.length, MAX_NETWORK_BODY_FIELDS);
    assert.equal(capped?.truncated, true);
  });

  it("lists a __proto__ key as a name and assigns nothing by key", () => {
    assert.deepEqual(shapeOf(raw('{"__proto__":{"polluted":"yes-Pr1"}}'), ["yes-Pr1"]), {
      kind: "json",
      fields: [
        { name: "__proto__", depth: 1, kind: "object", filled: true },
        { name: "polluted", depth: 2, kind: "string", filled: true },
      ],
    });
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  });

  it("parses JSON split over chunks, also inside a character, and after a byte order mark", () => {
    const bytes = new TextEncoder().encode('{"name":"å-Ch1"}');
    const cut = bytes.indexOf(0xc3) + 1;
    assert.deepEqual(
      shapeOf(
        { raw: [{ bytes: copyOf(bytes.slice(0, cut)) }, { bytes: copyOf(bytes.slice(cut)) }] },
        ["Ch1"],
      ),
      { kind: "json", fields: [{ name: "name", depth: 1, kind: "string", filled: true }] },
    );
    assert.deepEqual(shapeOf(raw('\u{feff}{"a":1}'), []), {
      kind: "json",
      fields: [{ name: "a", depth: 1, kind: "number" }],
    });
  });

  it("parses a JSON body of any size Firefox gives uncut, and no cut one", () => {
    const body = new TextEncoder().encode(`{"a":"${"x".repeat(2_000_000 - 8)}"}`);
    assert.equal(body.byteLength, 2_000_000);
    const json = { kind: "json", fields: [{ name: "a", depth: 1, kind: "string", filled: true }] };
    const whole = [{ bytes: copyOf(body) }];
    const split = [
      { bytes: copyOf(body.slice(0, 1_000_000)) },
      { bytes: copyOf(body.slice(1_000_000)) },
    ];
    assert.deepEqual(shapeOf({ raw: whole }, ["xxxx"]), json);
    assert.deepEqual(shapeOf({ raw: split }, ["xxxx"]), json);
    for (const chunks of [whole, split]) {
      const cut = chunks.map((chunk, index) =>
        index === chunks.length - 1 ? { ...chunk, truncated: true } : chunk,
      );
      assert.deepEqual(shapeOf({ raw: cut }, ["xxxx"]), { kind: "other", filled: true });
    }
  });

  it("gives other bodies as other, filled when they had bytes", () => {
    const bodies: [RequestBody, string[]][] = [
      [raw('"string-Ot1"'), ["string-Ot1"]],
      [raw("123457"), ["123457"]],
      [raw("true"), []],
      [raw("null"), ["null"]],
      [raw('{"a":"unfinished-Ot2"'), ["unfinished-Ot2"]],
      [raw("plain text-Ot3"), ["text-Ot3"]],
      [
        { raw: [{ bytes: copyOf(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])) }] },
        [],
      ],
      // Firefox cut the body: even a prefix that parses is not read as JSON.
      [{ raw: [{ bytes: bytesOf('{"a":"cut-Ot4"}'), truncated: true }] }, ["cut-Ot4"]],
      [
        { raw: [{ bytes: bytesOf('{"a":') }, { bytes: bytesOf('"cut-Ot5"}'), truncated: true }] },
        ["cut-Ot5"],
      ],
    ];
    for (const [body, secrets] of bodies) {
      assert.deepEqual(shapeOf(body, secrets), { kind: "other", filled: true });
    }
    assert.deepEqual(shapeOf({ raw: [] }, []), { kind: "other", filled: false });
    assert.deepEqual(shapeOf({ raw: [{ bytes: new ArrayBuffer(0) }] }, []), {
      kind: "other",
      filled: false,
    });
  });

  it("gives a body with a file, Firefox's error or nothing it reads as other alone", () => {
    const bodies: [RequestBody, string[]][] = [
      [{ raw: [{ bytes: bytesOf('{"a":"v-Fl1"}') }, { file: "<file>" }] }, ["v-Fl1", "<file>"]],
      [{ raw: [{ file: "<file>" }] }, ["<file>"]],
      [{ raw: [{}] }, []],
      [{ error: "Unable to read request body-Er1" }, ["Er1"]],
      [{}, []],
    ];
    for (const [body, secrets] of bodies) {
      assert.deepEqual(shapeOf(body, secrets), { kind: "other" });
    }
  });
});

/** The shape, checked to hold none of `secrets`. */
function shapeOf(body: RequestBody, secrets: readonly string[]): NetworkBody | undefined {
  const shape = bodyShape(body);
  const serialized = JSON.stringify(shape);
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `${secret} in ${serialized}`);
  }
  return shape;
}

function text(name: string, filled: boolean): NetworkBodyField {
  return { name, depth: 1, kind: "text", filled };
}

/** The name as a secret to look for, unless it is empty (every text contains ""). */
function nonEmpty(name: string): string[] {
  return name === "" ? [] : [name];
}

function raw(body: string): RequestBody {
  return { raw: [{ bytes: bytesOf(body) }] };
}

function bytesOf(body: string): ArrayBuffer {
  return copyOf(new TextEncoder().encode(body));
}

function copyOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
