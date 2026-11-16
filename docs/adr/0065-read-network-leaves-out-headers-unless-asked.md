# 0065: read_network leaves out headers unless asked

**Status:** Accepted, 2026-11-16. Amends
[0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md); supersedes the
`PROTOCOL_VERSION` of [0043](0043-read-page-finds-lines-by-the-text-it-shows.md).

## Context

`read_network` returned every request with its request and response headers. On a real site a
read with a pattern and a limit of 60 returned about 61 KB, about 1 KB per request, almost all of
it headers, while an agent usually needs a request's URL, method, type and status first, and the
headers of one or two requests later. The only filter was `pattern`, a plain substring of the
URL, which [0016](0016-read-network-records-live-documents-with-non-blocking-web-request.md) put
in the extension so that `limit` counts matching requests. An agent looking for the scripts of a
page or for what failed had to read every request and sort them itself.

## Decision

- `read_network` returns each request's `requestHeaders` and `responseHeaders` only with
  `headers: true`. Without it both keys are absent from every request, not empty lists.
- `types` keeps only the requests whose recorded resource type is exactly one of the given
  strings: free text, case-sensitive, 1 to 20 entries of 1 to 1,000 characters each.
- `failed: true` keeps only the requests with status 400 or above or with Firefox's error. A
  redirect, and a request with no status or error yet, has not failed.
- The filters run in the extension, in `read` in `apps/extension/src/network-log.ts`, beside
  `pattern` and combined with it, before `limit` keeps the newest matching requests. Requests a
  filter leaves out do not set `truncated`.
- The log still records, redacts and counts the headers toward its character budget as before,
  so a later read can ask for them.
- The extension checks the new params itself (`networkOptions` in
  `apps/extension/src/handlers.ts`), as it does `pattern` and `limit`, since any MCP server the
  host serves can send them; the server's schema checks them too.
- `PROTOCOL_VERSION` is 4: an extension at protocol 3 would ignore the new params and return
  every request with its headers, so the handshake refuses a server and an extension of
  different versions.

## Alternatives rejected

- **Headers by default.** Results were mostly headers, about 1 KB per request, and most reads do
  not need them.
- **Filtering in the server.** Every request would still cross native messaging, and `limit`,
  applied in the extension, would count requests the server then drops.
- **An enum of Firefox's resource types.** Firefox's list grows, and the recorded type is
  whatever Firefox reports; a fixed list would refuse a type Firefox adds. The tool description
  names the common types instead.
- **A minimum status number.** It does not cover requests that failed with no status, such as a
  refused connection or a blocked request.

## Consequences

- A call with no options returns less than before: an agent that needs the headers asks again
  with `headers: true`.
- A misspelled type returns no requests rather than an error.
- An extension and a server of different protocol versions refuse each other until both are
  updated, as with [0043](0043-read-page-finds-lines-by-the-text-it-shows.md).
