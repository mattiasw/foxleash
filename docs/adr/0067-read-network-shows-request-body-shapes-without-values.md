# 0067: read_network shows the shape of a request's body, never its values

**Status:** Accepted, 2026-11-16. Amends
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md); supersedes the
`PROTOCOL_VERSION` of [0065](0065-read-network-leaves-out-headers-unless-asked.md).

## Context

`read_network` returned nothing of what a page sent. An agent debugging a form whose POST answered
500 could not confirm that the form's captcha token field was in the failing POST.

A request body carries what the page's protected fields hold. Firefox fills a saved login when
the page loads, the agent can click the form's button on an approved site, and the POST then
carries the password. Values would hand the agent what
[0010](0010-page-tools-withhold-credential-field-values.md) and
[0021](0021-autofilled-fields-are-protected.md) keep out of `read_page` and screenshots. A
deny-list of field names misses JSON bodies and custom names, and the background cannot ask the
page which values are protected when a request is sent.

Lengths leak too. Any edge on a size gives an exact length to an agent that can add to a field:
`type` k characters onto a password the user typed, submit, and read a per-value range, and a
bisection finds the length in about 7 submissions; or `fill_form` another field of the same body
with n characters until a whole-body range flips, without touching the protected field. Counts
follow values as well: `JSON.stringify({ pw: new TextEncoder().encode(password) })` sends one key
per byte, and listing each key, or a range of the key count, gives the length in one read, also of
an autofilled password. A form sends such an array as one name repeated (`pw[]=104&pw[]=117`, as
jQuery's `$.param` does) or as names with an index (`pw[0]=104&pw[1]=117`). Names carry values when a body is not really a form (below) and when a
page uses a value as a JSON key, such as an email address or a code.

What Firefox gives, read from `WebRequestUpload.sys.mjs`, `WebRequest.sys.mjs` and `greprefs.js`
in the omni.ja of Firefox 156, the build the end-to-end tests run:

- `onBeforeRequest` with `["requestBody"]` sets `requestBody` to `null` for a request with no
  upload stream, else to `{ formData }`, `{ raw, lenientFormData }` or `{ error }`.
- `formData` is given for `multipart/form-data` and `application/x-www-form-urlencoded`, taken
  from the request's `Content-Type` header whatever the body is, and parsed in full: a plain
  object of `name: [values]`. A urlencoded part with no `=` gives the value `undefined`, so JSON
  or a bare token posted with the form content type (the default of jQuery's `$.post` and axios
  for a string) arrives as a name holding the body text; a base64 token with `=` padding arrives
  as a name with one empty value. A multipart file part gives its file name, or `""`, never its
  content. A malformed body falls back to `raw`.
- `raw` is a list of chunks, `{ bytes }`, with `truncated: true` when Firefox cut the body, or
  `{ file: "<file>" }` for a file stream. Firefox reads at most
  `webextensions.webRequest.requestBodyMaxRawBytes`, 16,777,216 bytes by default.
- Firefox copies the body into the background for every request matching the listener's filter,
  `<all_urls>`, not only the session's tabs.

## Decision

- `onBeforeRequest` in `apps/extension/src/network-log.ts` asks for `["requestBody"]`; it stays
  non-blocking. `entryOf` reduces the body to its shape with `bodyShape` in
  `apps/extension/src/request-body.ts` as the request arrives; the log never keeps a value.
- `read_network` returns the shape as `requestBody` only with `body: true`, checked in the
  extension (`networkOptions` in `handlers.ts`, since any MCP server the host serves can send it)
  and in the server's schema. Without it no request has the key.
- The shape has a `kind`: `form`, `json` or `other`. Its fields each have a name, a depth, a kind
  (`text` for a form value; `string`, `number`, `boolean`, `null`, `object` or `array` for JSON)
  and, for text, strings, objects and arrays, `filled`. An `other` body has `filled` when
  Foxleash got its bytes. No size, size range, length or count anywhere.
- A name is shown only when it matches `NETWORK_BODY_NAME` (an ASCII letter or `_`, then letters,
  digits and `_ . : $ [ ] -`, at most 100 in all). The names an object or form has that do not
  match give one `(name withheld)` field, at the first of them, describing its value; the others
  are skipped without counting.
- Of a JSON array only the first element is listed, named `[]`. In the same way a form name is
  listed once, filled by its first value, and of the names an object or form has that differ only
  in numbers in brackets (`a[0]`, `a[1]`) only the first is listed.
- At most 100 fields, at most 4 deep, chosen breadth-first and listed depth-first; `truncated` is
  set when the cap or the depth left a field out.
- A raw body is JSON when Firefox did not cut it, it is at most 1,000,000 bytes, it decodes as
  strict UTF-8 and parses as an object or array. Otherwise it is `other`.
- A form body is `other` with no fields when any value is `undefined`, any name starts with `{`
  or `[` after leading whitespace, or it has one name with one value that is empty or only white
  space (a token with `=` padding, perhaps followed by a line break). Firefox's trace of an
  empty part, the name `""` with only `undefined` values, is left out first.
- A file chunk and Firefox's `error` give `{ kind: "other" }`; neither string is forwarded.
- The server's schema repeats the name rule, the bounds and the closed kind lists, and strips
  unknown keys.
- `PROTOCOL_VERSION` is 5: an extension at 4 would ignore `body` and return no shapes, which an
  agent would read as a POST that sent nothing.

## Alternatives rejected

- **Whole bodies with values redacted by field name.** A deny-list misses JSON bodies and custom
  names, and the background cannot tell which values came from protected fields.
- **Exact lengths, or size ranges for values, whole bodies or entry counts.** Each gives an exact
  length to an agent that can add to a field or send a byte array, as above. Sizes can be added
  later; removing them would break agents.
- **Cutting long names instead of withholding them.** A cut keeps the start of a value.
- **One field per withheld key, per array element, per value of a form name or per index of a
  form array.** Their count follows a value's length.
- **Choosing fields depth-first.** A large early object would hide later top-level keys, such as
  a captcha token after a data object.
- **Shapes in every read.** Most reads do not need them, as with headers in
  [0065](0065-read-network-leaves-out-headers-unless-asked.md).
- **Parsers for other content types.** No task needs one yet; such a body shows as `other`.
- **One listener per recorded tab, so other tabs' bodies never reach the background.** It adds
  listener bookkeeping to the live-document logic for memory that is dropped at once.

## Consequences

- Names, kinds, the number of distinct plain names and which of them are empty show: a code typed
  into one box per digit, each box with a name of its own, shows its length.
- A value used as a name or key shows when it matches the name rule: a plain word, or a token,
  UUID or JWT that starts with a letter or `_` and is at most 100 characters long. So does a piece
  of a value in a body a page builds by joining text without escaping it (`pass=p&ss=w0rd` shows
  `ss`).
- A real form of one field that is empty or holds only white space shows as `other`.
- With `headers: true` the `Content-Length` request header gives a body's exact length in bytes,
  as it did before this change; the end-to-end test of a login form checks that Firefox sends it.
- A form sent with GET puts its values in the URL, which `read_network` shows.
- A multipart file field looks like a text field, and file sizes are not shown.
- Requests of frames from other sites show the shapes of their bodies too.
- A JSON body that grows past 1,000,000 bytes turns from `json` to `other`: an agent that can fill
  another field of the same body with enough text can find the body's exact length from where it
  turns, as `Content-Length` gives it.
- Unverified: a form body Firefox cannot read as text, such as a urlencoded Blob, may show as a
  form with no fields.
- Firefox parses form bodies in full and copies every body (raw up to 16 MiB) of every tab into
  the background, in memory only, where it is dropped unless the request is recorded. Foxleash
  parses JSON of at most 1,000,000 bytes; a form, which Firefox has already parsed whatever its
  size, it reads once more, name by name, for a top-level POST in any tab and for other requests
  only when they are recorded.
- An extension and a server of different protocol versions refuse each other until both are
  updated.
- Body values would need a later ADR, through a content script that remembers every value a
  protected field held and strips them from stored bodies; the trigger is a task that needs a
  value.
