# 0107: upload_file catches the file picker a click on a button or link opens

**Status:** Accepted, 2026-11-24.

## Context

Firefox gives extensions no real user gesture. A page opens its file picker from its own click
handler, with `input.click()` or `input.showPicker()`, and Firefox opens it only within the
transient user activation of a real click, 5 seconds (`dom.user_activation.transient.timeout`).
Upload buttons such as Gmail's Attach files make a file field they never add to the document and
call its `click()`: `read_page` shows no field, and the isolated content script
([0009](0009-content-scripts-injected-per-tab.md)) can neither see that field nor wrap the page's
`click()`. Gmail's compose window also takes dropped files only on a drop area it shows once a
drag enters, which a drop sent to the element itself never reached.

## Decision

- **Route by role.** `uploadFile` (`apps/extension/src/page-upload.ts`) gives a file field the
  files as before. An element whose `read_page` role (`roleOf`) is `button` or `link` is clicked
  through the click tool's code, under the protected-GET guard of
  [0080](0080-click-and-enter-do-not-send-protected-fields-with-get.md), with its refusals. Any
  other element gets a drop at its visible centre; after the drag enters, two pauses of
  `DRAG_START_MS` let the page show a drop area, which the drag moves onto, and a drop the page
  does not cancel is refused.
- **The catcher.** `catchFilePickers` (`apps/extension/src/file-picker-catcher.ts`), a
  self-contained function shipped in the package, runs in the page's main world. The background
  injects it on every `upload_file` request, into frame 0 only, through the `prepare` step of
  `PageScripts.request` (`page-scripts.ts`), which runs after the page tools' gate and the content
  script's injection (`installCatcher` in `handlers.ts`). It installs once per document and only
  on the gated site, and adds two window listeners. Armed by the content script right before the
  click (`armPickerCatch`), it wraps `HTMLElement.prototype.click` and
  `HTMLInputElement.prototype.showPicker`; the first call on a file field of that document opens
  no picker and is handed to the content script as the detail of a window event, and the catcher
  disarms, putting the originals back. Every other call goes to the original.
- **Handover.** The catcher hands over the element; the content script checks it through
  Firefox's Xray wrapper (an `HTMLInputElement` of type `file` in the clicked element's document)
  and sets the files itself with `intoField`. The catcher never sees a file.
- **Bounds.** The content script waits `PICKER_WAIT_MS` (5 s) for a catch and ignores one after
  its deadline by the clock; the catcher disarms after 10 s by a timer, or by the clock at its next
  call when Firefox delayed the timer. One catch per document at a time.
- **Result.** `picker: true` with `target: "input"`; no protocol bump, since an older server
  ignores the key ([0072](0072-the-extension-serves-the-server-of-the-release-before.md)).

## Alternatives rejected

- **`exportFunction` from the content script.** It hands the page a function from the
  extension's world, which [0015](0015-console-recorder-in-the-page-world.md) rejected.
- **A main-world script registered by URL.** It would run in the user's own tabs (0015).
- **A real gesture.** An extension cannot make one.
- **Leaving Attach buttons unsupported.** Attaching a file is a common task.
- **A new `target` value.** An older server would refuse the reply, needing a protocol bump.
- **Passing a page-realm `DataTransfer` to the catcher**, which would set the files. The catcher
  would hold the files, and the checks would run in the page's world.

## Consequences

- Not caught: a page that kept its own reference to `click` before arming, a `<label>` that
  forwards the click, a click event the page dispatches on the field itself, a picker asked for
  after 5 seconds, a field of a frame or of another document. Each is refused after the wait.
- The page can see the catcher and drive it within its own page, which gets the call's files
  either way. While it is armed, the user's own click on the page's upload control opens no
  picker either.
- A button or link that opens no picker costs 5 seconds and was clicked; the refusal says so. A
  drop zone with the role `button` is now clicked, not dropped on.
- An older server, which the extension still serves, describes a drop for every element that is
  not a file field.
- A drop area a page shows later than the two pauses is missed, and the drop is refused.
