# 0019: download fetches the file in the background page and saves it through browser.downloads

**Status:** Accepted, 2026-10-23. Amended by [0099](0099-download-cancels-redirect-hops-to-sites-the-session-may-not-act-on.md), 2026-11-19: a redirect hop of the fetch to a site the session may not act on is cancelled before it is sent, so the rejected alternative "`webRequestBlocking`" and the consequence that redirect hops are requested with their own sites' cookies no longer hold.

## Context

Firefox handles some files by a per-user setting: a PDF, for example, can be set to open in an
external application instead of being saved. An agent that follows a link to a receipt then
gets no file, and Foxleash had no way to save one. The file is needed in the folder where Firefox
puts the user's downloads, where the agent's own file tools can pick it up.

The save has to keep the site gate (ADR 0007): the agent may only get content from sites the
session is approved for, and a request carries the user's cookies for the site it goes to.

Experiments in Firefox 156.0.1 headless, from a throwaway extension with `downloads`,
`webRequest` and `<all_urls>`:

1. `downloads.download({ url })` of `http://127.0.0.1:P/redir`, which answers 302 to
   `http://localhost:P/slow.txt`, completed and saved the localhost body. A `DownloadItem` has
   no final URL: its `url` stays the start URL.
2. A non-blocking `webRequest` listener sees the download's request (`tabId` -1, one
   `requestId` across the redirect), and `downloads.cancel(id)` from `onBeforeRedirect` stopped
   it, but only because the body was slow: the cancel is asynchronous and races a small body.
3. HTTP 404 and 403 end as `interrupted` with no file; a refused connection as `interrupted`.
4. Firefox refuses a `filename` with `..`, a leading dot, characters it would change, a
   trailing dot or space, a backslash, or a `.desktop` extension ("filename must ..."). It
   accepts `sub/x.txt` and creates the folder `sub/`. `conflictAction: "uniquify"` saved a
   second `plain.txt` as `plain(1).txt`. An absolute `filename` is refused.
5. A background `fetch(url, { credentials: "include" })` sends the site's cookies, `SameSite`
   `Lax`, `Strict` and unset alike, and `response.url` is the final URL after redirects.
6. `downloads.download` of a blob URL from the background, with `saveAs: false`, saved
   `$HOME/Downloads/receipt.pdf` in a profile with no download prefs.
7. That fetch sends no `Origin`, no `Referer` and nothing containing `moz-extension`.
8. With the PDF handler set to an external application, saving a fetched attachment PDF as a
   type-less Blob through `downloads.download` launched no application; a trusted click on the
   same kind of link did. `saveAs: false` also saved with "Always ask where to save" on.
   Without `filename`, Firefox names the file from the URL and ignores `Content-Disposition`.

## Decision

The `download` tool (`apps/extension/src/downloads.ts`) takes a URL and a file name and returns
`{ path, bytes }`. The extension requests the `downloads` permission.

- The extension fetches the file itself, from the background page, with
  `{ credentials: "include", cache: "no-store" }`, and saves the bytes through
  `downloads.download` of a blob URL with `saveAs: false` and `conflictAction: "uniquify"`.
  The Blob has no type.
- The site gate runs three times, never asking: on the start URL before the request; on
  `response.url` once the headers arrive, before the status or a byte of the body is read; and
  on `response.url` again after the body, just before the save. Each check refuses a blocked
  site, then a site the session is not approved for. Asking would need a tab for the prompt,
  and `download` has none; the agent opens the site with `tab_open` or `navigate` first.
- The file name is required and must be a plain name: at most `MAX_DOWNLOAD_NAME_BYTES` (200)
  bytes in UTF-8, no slash or backslash, no control or format character, not starting with a
  dot (`downloadNameProblem`). Firefox's own refusals map to fixed sentences; its text is never
  passed on.
- A file is at most `DOWNLOAD_MAX_BYTES` (100 MiB, `packages/protocol`): a larger
  `Content-Length` is refused before the body, and the body is counted as it arrives. The whole
  call is bounded by `DOWNLOAD_TIMEOUT_MS` (50 s), below the host's request timeout; on expiry
  the fetch is aborted, nothing is handed to Firefox afterwards, and a save still in progress is
  cancelled. A save Firefox completes at that same moment stays in the download folder.
- One download runs at a time, across sessions; another call meanwhile is refused at once.
- The result goes through the server's untrusted framing like every other result. The
  download stays in Firefox's downloads panel and history.

## Alternatives rejected

- **`downloads.download` of the http URL.** It follows a redirect from an approved site to any
  other site and saves that site's file, fetched with its cookies, and Firefox gives no final
  URL to check (experiment 1). Open redirects are common on large sites.
- **Cancelling from a non-blocking `webRequest` listener.** The cancel races the body and loses
  for a small file (experiment 2).
- **`webRequestBlocking`.** A second new permission, for what the fetch already gives.
- **Saving through the MCP server in its working folder, as ADR 0011 does for screenshots.**
  The bytes would cross native messaging, whose frames are capped at 64 MiB, and the task is a
  save into the folder where Firefox puts the user's downloads, shown in its downloads panel.
- **Asking for approval from `download`.** The prompt is a page shown in a tab.
- **Letting Firefox name the file.** It names it from the URL, not from `Content-Disposition`.
- **Names with folders.** Firefox creates the folders inside the download folder.

## Consequences

- The extension holds up to 100 MiB of a file in memory while it saves it, one call at a time.
- The download history shows a `blob:` source, not the link.
- The file's content reaches the agent through its own file tools, outside Foxleash's untrusted
  framing; the tool description tells it to treat the content as data.
- Redirect hops, and a final URL the gate then refuses, are requested with their own sites'
  cookies, as for `navigate`; only the final response's body is read, and only on an approved
  site.
- The fetch uses the default cookie jar, so sessions in private windows or containers are not
  covered, and neither are downloads that need a POST or a page script's `blob:` URL.
- A fooled agent can fill the disk by at most 100 MiB per call; each save shows in the
  downloads panel.
- Whether Firefox opens its downloads panel for these saves, and whether that moves focus,
  cannot be seen headless and is unverified.
- ADR 0011's rejection of `browser.downloads` for screenshots still stands: different files,
  different folder. The permission is added before the first signed release, so it is part of
  the first version's permission set.
