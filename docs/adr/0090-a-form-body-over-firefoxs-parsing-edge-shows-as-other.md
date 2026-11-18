# 0090: A form body over Firefox's parsing edge shows as other

**Status:** Accepted, 2026-11-18. Amends [0070](0070-read-network-hides-request-body-lengths.md).

## Context

[0070](0070-read-network-hides-request-body-lengths.md) accepted one edge where a request body's
length reaches the agent, Firefox's cut of a raw body at 16,777,216 bytes, and said that "a form
body has no such edge, since Firefox parses `formData` in full". It has one, at 1 MiB.

Measured with a probe add-on (one non-blocking `onBeforeRequest` listener with `["requestBody"]`)
and a local server counting the bytes it received, in headless Firefox 160.0.1 and 153.7.0esr,
with identical results in both. Each body held one field `a` unless said otherwise; each side of
each edge was sent at least twice.

| Body | Largest with names | At 1,048,576 bytes and above |
|---|---|---|
| urlencoded: `fetch` of a string, `URLSearchParams`, `XMLHttpRequest`, a `Blob`, a top-level `<form method="post">` | 1,048,575 | `{ formData: {} }` (also at 1,048,577 and 17,000,000) |
| multipart: `fetch(new FormData(...))`, a top-level `enctype="multipart/form-data"` form, a string with a fixed boundary | 1,048,575 | no `formData`; `raw` with all the body's bytes |
| multipart with a page-built `File` between two text fields | 1,048,575 (a 1,048,161-byte file) | `raw` with the whole body (also at 2,000,000 and 4,000,000) |

- The edge is a byte count, not a name count: a urlencoded body of 115,969 names padded to
  1,048,575 bytes arrived with all of them, and at 1,048,576 bytes with none.
- A file's bytes count toward the edge. Not measured: a file the user chose from the computer,
  which Firefox may hand over as a file stream apart from the rest.
- A body sent with the urlencoded type that Firefox's form parser cannot decode (it runs
  `decodeURIComponent` on each name and value, which throws on an invalid escape), such as
  `p=%E9&a=…` or JSON holding a `%` (`{"a":"100%","b":"…"}`), arrives as `raw` with all its bytes
  at 1,000 and 1,048,575 bytes, and as `{ formData: {} }` at 1,048,576. Foxleash showed the first
  as `other` with `filled: true` and the second as `json` with its keys below the edge; at the edge
  both turn. So JSON holding such a `%`, sent with the urlencoded type, has its JSON edge at 1 MiB,
  not 16 MiB.
- On a page in windows-1252, a top-level urlencoded form sends a character outside the page's
  charset (U+4E2D) as `%26%2320013%3B`, 14 bytes (1,000 such characters made a 14,002-byte body),
  with the same edge; a multipart form sends it as `&#20013;`, 8 bytes (8,162 bytes for 1,000).
- An empty form body gives `{ formData: {} }` too: a 0-byte urlencoded body (an empty string, an
  empty `URLSearchParams`, a top-level form with no successful controls) and a multipart body with
  no parts (`fetch(new FormData())`, 57 or 59 bytes; a top-level multipart form, 59 bytes; the
  string `--b0undary--\r\n`, 14 bytes).
- Earlier, in Firefox 160.0.1: a 1,000,000-byte urlencoded body arrived with all 111,112 names,
  and bodies of 4,000,000 and 16,000,000 bytes and a 2,000,000-byte top-level form POST of 211,111
  hidden inputs as `{}`.

Why, read in both versions' `modules/WebRequestUpload.sys.mjs`: `getTextStreams` yields only
`nsIStringInputStream` sub-streams. With none, the urlencoded parser sees no text and returns an
empty map, `createFormData` returns it as `{}`, and `createRequestBody` returns
`{ formData: {} }`, never falling back to `raw` because `{}` is truthy. The multipart parser instead
starts from a `"\r\n"` tail, finds no header block and throws "Invalid MIME stream", so
`createFormData` returns `null` and `createRequestBody` falls back to `getRawDataChunked`, which
reads any stream that is not a file. The ESR's copy differs only in building the object with
`mapToObject` and in an early `{ error: "Upload streams with headers are unsupported" }`, which no
measured body hit. Why the edge sits at 1 MiB is an unverified hypothesis: Firefox sends a body of
1 MiB or more from the content process as a stream that is not a string stream.

Before this decision, `formShape` in `apps/extension/src/request-body.ts` turned `{}` into
`{ kind: "form", fields: [] }`: a urlencoded form over the edge, or an empty one, showed as a form
that sent nothing. A multipart one over the edge showed as `other` with `filled: true`, through
`rawShape`.

## Decision

- Foxleash accepts Firefox's edge and sets no form limit of its own.
- A `formData` with no own key becomes `{ kind: "other" }` with no `filled` (`formShape` in
  `apps/extension/src/request-body.ts`), whatever the body's size, so an empty form shows as
  `other` too: Foxleash cannot tell the two apart. A `formData` with only Firefox's trace of an
  empty part (`{ "": [undefined] }`) stays a form with no fields, since Firefox read that body.
- A multipart body over the edge keeps the shape `rawShape` gives Firefox's raw bytes, `other`
  with `filled: true`, the same at every size from the edge on, past Firefox's 16 MiB raw cut too.
- The `read_network` tool description names this cause of a bare `other`.
- The result's shape is unchanged; `PROTOCOL_VERSION` stays as it is.

## Alternatives rejected

- **Showing no form field names at all.** It removes the edge, but loses the field names of every
  login and checkout POST, the main use of `body: true`.
- **A Foxleash limit below Firefox's edge**, on a size computed from `formData` (names and values)
  or taken from `Content-Length` or Firefox's `requestSize`. It is the same channel at a smaller,
  cheaper size. A clamped estimate also moves the edge by the bytes each escaped character of the
  protected value adds, so it leaks content as well as length.
- **A limit on an upper bound that counts every value as at least some floor `m` bytes**, such as
  `Σ(3·utf8(name) + 119 + max(3·utf8(value), m)) + 76` from `formData`, names shown only while it is
  at most 1,048,575. Where it applies, a protected value shorter than `m/3` bytes no longer moves
  where the names vanish (modelled, not measured in Firefox). It closes the channel only for short
  values in a body Firefox parses into `formData` with no file part:
  - a multipart form with a file field is still measured by the file, whose bytes count toward
    Firefox's edge while `formData` carries only its name, so one `upload_file` call sets each
    probe's size;
  - a body Firefox cannot decode (a page in a legacy encoding sends a letter like `é` as `%E9`)
    still turns from `other` with `filled` to `other` at Firefox's edge;
  - a value that holds text the agent types next to a protected value is still measured.

  It also makes the names of ordinary large forms vanish well before Firefox's edge (an ASCII
  body from about a third of it, a form of about 900 fields or more with `m = 1024`), and its byte
  model has to stay an upper bound for every encoding Firefox sends, or the channel returns
  unnoticed. The docs would still have to describe the same edge, at the same cost, for the cases
  above.
- **A secret or random limit**, for 0070's reasons: a fixed secret one is calibrated with a body
  the agent controls; a random one leaks statistically.
- **Reading the field names from the page's form at submit.** It covers only a top-level
  submission in a tab Foxleash scripts, never `fetch` or XMLHttpRequest bodies, and is a new
  page-side recorder.
- **A cap on how much `type` or `fill_form` put into a field.** It does not bound the body (text a
  field already holds, hidden fields, `upload_file`, 14 bytes a character on a legacy page) and
  breaks editing long text.
- **Keeping `form` with no fields.** It says the form sent nothing.

## Consequences

The cost to use the edge, computed the way 0070 does. One `type` call appends at most 50,000
characters; `fill_form` sets each field's value, at most 50,000 characters a field and 100,000 a
call, so repeated calls never add up in one field; `batch` runs at most 20 steps. To reach
1,048,576 bytes:

| Body and characters | Bytes a character | Characters | `type` calls | Or with `fill_form` |
|---|---|---|---|---|
| urlencoded, UTF-8 page, `€` | 9 | 116,509 | 3, one `batch` | 2 calls: two fields, then one `type` |
| urlencoded, top-level form on a legacy page, `%26%23NNNNN%3B` | 14 | 74,899 | 2 | 1 call over two fields |
| multipart, UTF-8, `€` | 3 | 349,526 | 7 | 4 calls over seven fields (6 with two fields) |
| multipart, legacy page, `&#NNNNN;` | 8 | 131,072 | 3 | 2 calls over three fields |
| ASCII | 1 | 1,048,576 | 21, two `batch` calls | 11 calls over 21 fields (20 with two fields) |

- On a UTF-8 page no character takes more than 9 bytes a UTF-16 unit in a urlencoded body (an
  astral character is 12 bytes for 2 units, a line break 6).
- A multipart form with a file field takes one `upload_file` call of about 1 MiB. A page-built
  `File` counts toward the edge (measured); `upload_file` builds the same kind of `File` in the
  page (`apps/extension/src/page-upload.ts`), but was not measured itself.
- Then each probe of the bisection is one submission of about 1 MiB. `type` only appends, so a
  form whose submission loads a new page is typed again in full for each probe: about 24 `type`
  calls and 8 submissions of 1 MiB for a 0 to 255 byte range. On a form that stays on its page
  with a second text field, the padding is typed once and each probe is one `fill_form` and one
  click. The edge is a documented constant, so no calibration is needed; the bisection gives the
  protected value's length plus that of any field the agent cannot read, such as a hidden one.
  Compare 0070's 56 to 336 `type` calls for JSON at 16 MiB.
- Not measured, as in 0070: whether text fields and the page take that much text, a form with a
  file the user chose from the computer, and a body a page builds from several `Blob` parts, which
  Firefox may give as separate streams, so that only some of its names show.
- The edge was there before this decision (a form's names, then none); it now reads as names, then
  `other`. An empty form now shows as `other`, not as a form with no fields.
- Revisit when Firefox's form parser reads streams that are not string streams, or the edge moves:
  the end-to-end test "a form body shows its field names up to Firefox's edge for form bodies,
  other past it or empty" in `e2e/network.test.ts` then fails, and this ADR and the docs follow.
