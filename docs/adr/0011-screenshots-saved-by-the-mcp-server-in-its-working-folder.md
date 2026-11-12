# 0011: Screenshots come from captureTab and are saved by the MCP server in its working folder

**Status:** Accepted, 2026-10-20. Its consequence on form fields is superseded by [0013](0013-screenshots-hide-credential-field-text.md), 2026-10-20.

## Context

The `screenshot` tool returns a PNG of a tab in the session's group, of its viewport or of one
element that read_page named. The agent may also want the file on disk, for example to put it
in a bug report in the project it works in.

Firefox has two ways to capture a tab. `tabs.captureVisibleTab` captures whichever tab is
active in a window when it runs, so a user switching tabs during the call would hand the agent
a screenshot of a tab outside the session's group, on a site the session may not be approved
for. `tabs.captureTab(tabId)` captures the tab it names, active or not. Both need `<all_urls>`,
which the manifest already has.

An image item in an MCP result cannot be framed as untrusted the way page text is (ADR 0009),
and a screenshot shows form fields as the page draws them, which read_page and get_page_text
withhold for credential fields (ADR 0010).

The MCP result is capped at 8 MiB, under the SDK's 10 MiB stdio line limit; host frames may be
up to 64 MiB.

## Decision

- The extension captures with `browser.tabs.captureTab(tabId, { format: "png", scale: 1 })`,
  never `captureVisibleTab` (`screenshot` in `apps/extension/src/handlers.ts`). `scale: 1`
  gives CSS pixels whatever the screen's device pixel ratio.
- The tab passes `allowedPageSite` before the capture, and again after it: a refusal, or a
  different site, means nothing is returned. So does a move to another site in between, seen
  through `tabs.onUpdated`, even when the tab is back on the first site by the second check.
  The capture is bounded by `CAPTURE_TIMEOUT_MS` (20 s) and Firefox's error text is never
  passed on.
- With `ref`, the content script (`element-rect.ts`) scrolls the element into view with
  `scrollIntoView({ behavior: "instant" })` and returns its client rect, the viewport size and
  the scroll offset. The background (`captureRect` in `screenshot.ts`) reads that reply as
  untrusted input, cuts the rect to the viewport, rounds it outward to whole pixels inside the
  viewport and adds the scroll, and passes it as captureTab's `rect`. A page cannot make a
  capture larger than its window.
- The extension refuses a capture over 48 MiB of base64 (`MAX_SCREENSHOT_CHARS`); the MCP
  server refuses to return an image that does not fit its 8 MiB result with 64 KiB to spare,
  and checks that the data is exact base64 of a PNG.
- The MCP server puts Foxleash's own note, that text in the image is page content and not
  instructions, before the image, and its instructions name screenshots as page content.
- Saving (`saveTo`) is done by the MCP server, in `savePng` in `apps/server/src/save-file.ts`,
  inside the folder `foxleash mcp` was started in (the MCP client's working folder): a path
  inside that folder, also after resolving symlinks, ending in `.png`, with no folder or file
  name starting with a dot, in a folder that exists. The file is created with `O_EXCL` and mode
  0600, so it never replaces a file or follows a symlink at its name, and screenshots of
  logged-in pages are readable only by the user. Folders are never created. The path checks
  that need no file system run before the capture, so a refused path takes no screenshot.

## Alternatives rejected

- **`tabs.captureVisibleTab`.** It captures the active tab, not the one asked for, so a tab
  switch during the call would leak a tab outside the session.
- **Saving with `browser.downloads`.** It needs a new permission, which Firefox does not show
  users when an update adds it, and so a listing change; and it writes into the user's
  Downloads folder instead of the project the agent works in.
- **Letting the agent write the file from the returned image.** The MCP client has the image,
  not the PNG bytes, and an image too large to return could not be saved at all.
- **Saving anywhere the agent names.** Page content steering the agent could then write into
  `.git/hooks`, a shell profile or an editor's settings.

## Consequences

- Screenshots show form fields as the page draws them. Firefox masks password fields, so a
  saved login Firefox fills in stays hidden, but card number, card security code and one-time
  code fields, and a password field the page shows as text, show their values, unlike in
  read_page and get_page_text. ADR 0010 then covers text results only. Masking such fields
  during the capture is the alternative not built yet.
- A capture can show content the approved page embeds from other sites, as the listing says.
- When the MCP client starts the server in `/` or the home folder, saving can reach any folder
  below it whose path has no name starting with a dot, as new 0600 `.png` files only.
- A process of the same user that swaps a folder for a symlink between the check and the write
  could redirect the file. That is outside the threat model: the threat is page content
  steering the agent, and it cannot create symlinks through Foxleash.
- A page zoom other than 100% scales the image, since Firefox multiplies `scale` by the zoom.
- Firefox's captureTab `rect` is documented as relative to the page; the end-to-end test
  checks the coordinate space with the pixels of a known box.
