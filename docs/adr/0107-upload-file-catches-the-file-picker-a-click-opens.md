# 0107: upload_file catches the file picker a click on a button or link opens

**Status:** Accepted, 2026-11-24.

Amended 2026-11-25: a drop only the window or the document cancelled is flagged `pageWide`, not
refused; many pages cancel every drop only so Firefox does not open files.

## Context

Extensions get no real user gesture. Pages open their file picker from their own click
handler (`input.click()`, `input.showPicker()`), which Firefox honours only within the 5 s
transient activation of a real click. Upload buttons such as Gmail's Attach files call `click()`
on a file field never added to the document: `read_page` shows no field, and the isolated content
script ([0009](0009-content-scripts-injected-per-tab.md)) can neither see it nor wrap the page's
`click()`. Gmail's compose window takes dropped files only on a drop area it shows once a drag
enters.

## Decision

- **Route by role.** `uploadFile` (`apps/extension/src/page-upload.ts`) gives a file field the
  files. An element whose `read_page` role is `button` or `link` is clicked through the click
  tool's code, under the protected-GET guard of
  [0080](0080-click-and-enter-do-not-send-protected-fields-with-get.md). Any other element gets a
  drop at its visible centre after two pauses of `DRAG_START_MS`, so the drag can move onto a drop
  area the page shows; a drop the page does not cancel is refused. `sendDrop` listens on the
  document element: its drop, cancelled before the capture listener or only after the bubble
  listener, is flagged.
- **The catcher.** `catchFilePickers` (`apps/extension/src/file-picker-catcher.ts`) runs in the
  page's main world, injected on every `upload_file` request into frame 0 through the `prepare`
  step of `PageScripts.request`, after the page tools' gate (`installCatcher` in `handlers.ts`).
  It installs once per document, only on the gated site, with two window listeners. Armed right
  before the click (`armPickerCatch`), it wraps `HTMLElement.prototype.click` and
  `HTMLInputElement.prototype.showPicker`; the first call on a file field of that document opens
  no picker and hands the field to the content script in a window event, and the originals go
  back.
- **Handover.** The content script checks the field through Firefox's Xray wrapper (a file
  `HTMLInputElement` of the clicked element's document) and sets the files; the catcher never sees
  a file.
- **Bounds.** The content script waits `PICKER_WAIT_MS` (5 s), ignoring a late catch; the
  catcher disarms after 10 s, by a timer or by the clock. One catch per document at a time.
- **Result.** `picker: true` with `target: "input"`; `pageWide: true` with `target: "drop"`, whose
  text says to read the page and not to drop again. No protocol bump: an older server ignores the
  keys ([0072](0072-the-extension-serves-the-server-of-the-release-before.md)).

## Alternatives rejected

- **`exportFunction` from the content script.** It hands the page a function from the
  extension's world, which [0015](0015-console-recorder-in-the-page-world.md) rejected.
- **A main-world script registered by URL.** It would run in the user's own tabs (0015).
- **A real gesture.** Impossible for extensions.
- **Leaving Attach buttons unsupported.** Attaching a file is a common task.
- **A new `target` value.** Older servers would refuse it.
- **Passing a page-realm `DataTransfer` to the catcher.** The catcher would hold the files.
- **Refusing a drop only the window or the document cancelled.** The drop has already reached the
  page: pages that take files at the document (React 16 and older, jQuery delegation,
  drop-anywhere pages) would be refused, and the agent would drop the files twice.
- **Refusing before the drop when only the page cancelled `dragover`.** It refuses those pages
  outright.
- **Watching whether the page reads the drop's files.** It needs a function of ours in the page on
  every drop (0015).

## Consequences

- Not caught, so refused after the wait: a page's own saved `click`, a `<label>` that forwards
  the click, a click event dispatched on the field, a picker asked for after 5 s, a field of a
  frame or another document.
- The page can drive the catcher, and gets the files either way. While armed, the user's own
  click on the upload control opens no picker either.
- A button or link that opens no picker costs 5 seconds and was clicked; the refusal says so. A
  drop zone with the role `button` is clicked.
- An older server describes a drop for every element that is not a file field, flagged or not.
- A drop area shown later than the two pauses is missed, and the drop is refused.
- A page-wide cancel on a page that took nothing is still a drop, now flagged; so is a drop zone
  delegated to, or behind a capture-phase cancel on, the window or document, where reading the
  page shows the files.
- A listener on the document element counts as the page's in the capture phase, as the element's
  in the bubble phase. A guard on `body` or an app root counts as the element's: page-wide guards
  are usually on the window or document, and drop zones delegated to `body` stay unflagged.
