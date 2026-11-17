# 0070: read_network hides the length of a request's body

**Status:** Accepted, 2026-11-17. Amends
[0067](0067-read-network-shows-request-body-shapes-without-values.md) and
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md).

## Context

[0067](0067-read-network-shows-request-body-shapes-without-values.md) shows a request body's shape
and never a value's length, because an agent that can add to a field reads a length off any edge.
Two channels still gave the exact byte length of a body holding a protected value, such as a
password Firefox filled in:

- **The request's `Content-Length` header.** With `headers: true` it came through as sent: 73 for
  the end-to-end fixture's login POST in Firefox 156. The agent reads the other fields with
  `read_page`, so the header minus the known names, separators and values is the password's
  length, in one read.
- **The 1,000,000-byte JSON limit.** A raw body over it turned from `json` to `other`. Padding a
  writable field of the same body and bisecting finds the body's exact length from where it turns.

What Firefox gives, read from `greprefs.js`, `WebRequestUpload.sys.mjs` and `WebRequest.sys.mjs`
in the omni.ja of Firefox 156, the build the end-to-end tests run:

- A raw body is read up to `webextensions.webRequest.requestBodyMaxRawBytes`, 16,777,216 bytes by
  default. The chunk Firefox cut is marked `truncated: true`; when earlier chunks fill the limit
  exactly, what follows is lost with no mark. Either way the bytes after the cut never reach the
  extension.
- `formData` (urlencoded and multipart) is parsed by reading every stream to its end, with no
  limit.
- Event details also carry `requestSize`, the request's byte count, and a cut chunk carries
  `originalSize`. Foxleash records neither.

## Decision

- The value of a request's `Content-Length` header is redacted, its name kept, on every request,
  whether or not it sent a body. `REDACTED_REQUEST_HEADERS` in `apps/extension/src/network-log.ts`
  is `REDACTED_HEADERS` plus `content-length`; `onSendHeaders` calls
  `redactHeaders(details.requestHeaders, REDACTED_REQUEST_HEADERS)`. Response headers keep
  `Content-Length`, through the default set: it describes the response, whose body `read_network`
  never returns, and helps debugging.
- Foxleash sets no size limit of its own on JSON. `rawShape` in `apps/extension/src/request-body.ts`
  parses every raw body Firefox gives uncut; a body with a `truncated` chunk stays `other`.

## Alternatives rejected

- **Dropping the request's `Content-Length` header.** Redacting matches the credential headers,
  and the header's presence says nothing.
- **Redacting `Content-Length` in responses too.** It is not the channel, and it loses debugging
  information.
- **A secret or random JSON limit.** A fixed secret one is found by calibrating with a body the
  agent controls, for example after replacing the protected value and reloading so Firefox fills
  it again; a random one per request still leaks statistically.
- **Parsing only the first N bytes of every body.** A key after the cut vanishes at an offset that
  follows the value's length, now at N.
- **A hand-written streaming JSON scanner to bound memory.** It has the same edge at Firefox's cut
  and is a new parser of untrusted input, for memory alone.

## Consequences

- A request body's length reaches the agent from what Foxleash records only through Firefox's cut
  of a raw JSON body at its limit, or through a header a page's script derives from the body
  (below). A form body has no such edge, since Firefox parses `formData` in full.
- The remaining edge cannot be hidden, since any output for a cut body differs from the uncut one.
  Using it, the agent must fill a field the page sends to about 16 MiB, once: one text value is at
  most 50,000 characters, `type` adds up to that per call and `batch` runs 20 steps, so it takes
  about 56 to 336 `type` calls (3 to 17 `batch` calls), depending on how many bytes each character
  the field keeps takes in the JSON. Then each probe of the bisection is one submission of about
  16 MiB. On a page that puts an uploaded file's content into the same JSON body, `upload_file`
  calls of up to 10 MiB each can do the typing's work and set each probe's size. Not measured:
  whether Firefox's text fields and the page take 16 MiB.
- Shaping now costs up to about 3 s and about 0.5 GB per 16 MiB body (a flat object of about 1.4
  million keys: 3,036 ms, 376 MB more heap; a single string: 22 ms), measured in Node 24's V8;
  Firefox's engine was not measured. It runs synchronously in the background, which answers
  nothing meanwhile, for every recorded request and every top-level request in any tab. Any site
  can trigger it with no agent session, by sending a JSON body as a top-level `text/plain` form
  POST. Revisit on a report of Foxleash, or Firefox's extension process, stalling on a page that
  sends large bodies: then shape a top-level body only once its tab is known to be recorded, or
  parse off the background page.
- A site's own reaction to a body's size, such as a 413 from a server whose limit the body passes,
  shows in the status and the page, as it does to the user. Foxleash does not hide a site's answer.
- A header a page's script derives from the body still shows: a digest (`Content-Digest`,
  `Repr-Digest`, `Digest`, `Content-MD5`, `x-amz-content-sha256`), which for a login body whose
  other fields are known lets the agent test password guesses offline, or a length of its own such
  as `X-Upload-Content-Length`. Foxleash cannot know which custom headers derive from the body.
- Firefox's `requestSize` and a cut chunk's `originalSize` stay unrecorded, for the same reason as
  `Content-Length`.
- A JSON body over 1,000,000 bytes now shows its keys. 0067's consequences that `Content-Length`
  gives a body's exact length and that Foxleash parses JSON of at most 1,000,000 bytes no longer
  hold.
- The result's shape is unchanged, so `PROTOCOL_VERSION` stays 5.
