import { UPLOAD_PICKER_WAIT_MS } from "@foxleash/protocol";
import { refError } from "./element-refs.ts";
import { armPickerCatch } from "./file-picker-catcher.ts";
import type { Point } from "./page-actions.ts";
import {
  DRAG_START_MS,
  deepElementAt,
  dragEvent,
  locate,
  type PointerState,
  sendDrag,
  timerTurn,
} from "./page-actions-dom.ts";
import { wait } from "./page-input-dom.ts";
import { isRecord, ownField, PageError } from "./page-messages.ts";
import { type PageMemory, roleOf } from "./read-page.ts";

// Firefox's waiver of Xray vision and its copy into another realm, in content scripts only.
declare const window: Window & { wrappedJSObject: PageRealm };
declare function cloneInto<T>(value: T, target: object): T;

interface PageRealm {
  DataTransfer: typeof DataTransfer;
  File: typeof File;
}

interface PageFile {
  name: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface UploadPage extends PageMemory {
  pointer: PointerState;
  /** Clicks the element `ref` names as the click tool does, with its refusals. */
  click: (ref: string) => void;
}

const NOT_TAKEN =
  "The page showed that it takes a drag there but did not take the dropped files. Give upload_file the ref of a file field, or of the button that opens the page's file picker.";

/**
 * upload_file in the page: sets the files of the file field `ref` names; clicks a button or link
 * and puts them into the file field the page asks to open a picker for; or drops them on any
 * other element, which takes them only when its page cancels `dragover` and `drop`, as in a real
 * drag. The role is the one read_page shows.
 */
export async function uploadFile(
  params: Record<string, unknown>,
  page: UploadPage,
): Promise<{ target: "input" | "drop"; picker?: true; pageWide?: true }> {
  const ref = ownField(params, "ref");
  if (typeof ref !== "string") {
    throw new PageError("invalid_params", "upload_file needs ref to be a string.");
  }
  const files = pageFiles(ownField(params, "files"));
  const lookup = page.refs.resolve(ref);
  if ("error" in lookup) throw refError(ref, lookup.error);
  const element = lookup.element;
  if (element instanceof HTMLInputElement && element.type === "file") {
    return intoField(element, files);
  }
  const role = roleOf(element, page);
  if (role === "button" || role === "link") return throughPicker(element, ref, files, page);
  return dropOn(ref, files, page);
}

function pageFiles(value: unknown): PageFile[] {
  if (!Array.isArray(value)) {
    throw new PageError("invalid_params", "upload_file needs files to be a list.");
  }
  return value.map((file: unknown) => {
    const name = isRecord(file) ? ownField(file, "name") : undefined;
    const type = isRecord(file) ? ownField(file, "type") : undefined;
    const bytes = isRecord(file) ? ownField(file, "bytes") : undefined;
    if (typeof name !== "string" || typeof type !== "string" || !(bytes instanceof Uint8Array)) {
      throw new PageError("invalid_params", "upload_file got a file it cannot read.");
    }
    // A copy on an ArrayBuffer of its own, which is what File takes.
    return { name, type, bytes: new Uint8Array(bytes) };
  });
}

/** Sets the field's files, once it is known to take them; `field` names it in a refusal. */
function intoField(
  input: HTMLInputElement,
  files: readonly PageFile[],
  field = "That file field",
): { target: "input" } {
  // Also true inside a disabled fieldset.
  if (input.matches(":disabled")) {
    throw new PageError("invalid_target", `${field} is disabled.`);
  }
  if (!input.multiple && files.length > 1) {
    throw new PageError(
      "invalid_target",
      `${field} takes one file, and ${files.length} were given.`,
    );
  }
  input.files = pageTransfer(files).files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { target: "input" };
}

/**
 * Clicks the element with the page's file picker catcher armed, and puts the files into the file
 * field whose picker the page asks for within UPLOAD_PICKER_WAIT_MS. No picker opens.
 */
async function throughPicker(
  element: Element,
  ref: string,
  files: readonly PageFile[],
  page: UploadPage,
): Promise<{ target: "input"; picker: true }> {
  const catcher = armPickerCatch(window, acceptInput(element), {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    now: () => performance.now(),
  });
  if (catcher === "busy") {
    throw new PageError(
      "no_effect",
      "Another upload_file is waiting for a file picker in this page; try again once it has answered.",
    );
  }
  if (catcher === "unanswered") {
    throw new PageError(
      "no_effect",
      `Foxleash could not get ready to take the file picker ${ref} may open, so it did not click it: this page does not let Foxleash take its file picker. Ask the user to upload the files, or give upload_file the ref of a file field or of a place that takes dropped files.`,
    );
  }
  try {
    page.click(ref);
    const input = await catcher.caught(UPLOAD_PICKER_WAIT_MS);
    if (input === undefined) {
      throw new PageError(
        "invalid_target",
        `Foxleash clicked ${ref}, but the page opened no file picker within ${UPLOAD_PICKER_WAIT_MS / 1000} seconds. Read the page: the click may have opened a menu or a dialog with a button or link to use. Foxleash clicks buttons and links, and drops files only on other elements.`,
      );
    }
    intoField(input, files, `Foxleash clicked ${ref}, but the file field the page opened`);
    return { target: "input", picker: true };
  } finally {
    catcher.disarm();
  }
}

/**
 * The caught detail when it is a file field of the element's document. Read through Firefox's
 * Xray wrapper, so the page's own replacements of `type` or `ownerDocument` do not count.
 */
function acceptInput(element: Element): (detail: unknown) => HTMLInputElement | undefined {
  return (detail) =>
    detail instanceof HTMLInputElement &&
    detail.type === "file" &&
    detail.ownerDocument === element.ownerDocument
      ? detail
      : undefined;
}

/**
 * Drops the files at the element's visible centre as a drag from outside the page would: the
 * events go to the element under that point, which can be a drop area the page shows over the
 * element once the drag enters. Refused unless the page cancels the last `dragover` and the drop;
 * a drop only the window or the document cancelled is flagged `pageWide`.
 */
async function dropOn(
  ref: string,
  files: readonly PageFile[],
  page: UploadPage,
): Promise<{ target: "drop"; pageWide?: true }> {
  // First: a throw here comes before the page is scrolled.
  const transfer = pageTransfer(files);
  const { point, hit } = locate({ ref }, page.refs, true);
  let current = hit;
  sendDrag(current, "dragenter", point, transfer);
  let accepted = false;
  // A page may show its drop area on dragenter or on the first dragover, in a later task; a real
  // drag repeats dragover while the pointer rests, so the first one's answer is not the last word.
  for (let turn = 0; turn < 2; turn += 1) {
    // In a hidden tab Firefox delays the page's timers too.
    await Promise.all([wait(DRAG_START_MS), timerTurn()]);
    const under = deepElementAt(point);
    if (under !== null && under !== current) {
      // HTML's drag-and-drop processing model: dragenter at the new element, then dragleave at the
      // old one, so a page that counts them keeps its drop area shown.
      sendDrag(under, "dragenter", point, transfer, current);
      sendDrag(current, "dragleave", point, transfer, under);
      current = under;
    }
    accepted = !sendDrag(current, "dragover", point, transfer);
  }
  page.pointer.over = new WeakRef(current);
  if (!accepted) {
    // A real drag that ends where dragover was not canceled leaves with dragleave.
    sendDrag(current, "dragleave", point, transfer);
    throw new PageError(
      "invalid_target",
      "That element is neither a file field nor a place that takes dropped files.",
    );
  }
  return sendDrop(current, point, transfer) === "page"
    ? { target: "drop", pageWide: true }
    : { target: "drop" };
}

/**
 * Sends the drop, refused unless the page cancels it, and says where it was cancelled: by a
 * listener below the document element (`"element"`) or only by the window's or the document's.
 */
function sendDrop(target: Element, point: Point, transfer: DataTransfer): "element" | "page" {
  const root = target.ownerDocument.documentElement;
  const sent = dragEvent(target, "drop", point, transfer);
  // Only our drop: the page may dispatch drops of its own meanwhile.
  let atCapture: boolean | undefined;
  let atBubble: boolean | undefined;
  const onCapture = (event: Event): void => {
    if (event === sent) atCapture = event.defaultPrevented;
  };
  const onBubble = (event: Event): void => {
    if (event === sent) atBubble = event.defaultPrevented;
  };
  // Added after the page's own listeners on the root, so in each phase those run first: its
  // capture ones count as the page's, its bubble ones as the element's.
  root.addEventListener("drop", onCapture, true);
  root.addEventListener("drop", onBubble);
  try {
    // A page that takes the files cancels the drop, or Firefox would open them.
    if (target.dispatchEvent(sent)) throw new PageError("invalid_target", NOT_TAKEN);
  } finally {
    root.removeEventListener("drop", onCapture, true);
    root.removeEventListener("drop", onBubble);
  }
  // Cancelled before the root, or stopped above it so that nothing below could cancel it.
  if (atCapture !== false) return "page";
  // Stopped below the root after it went down uncancelled: a drop zone that stops propagation.
  if (atBubble === undefined) return "element";
  return atBubble ? "element" : "page";
}

/**
 * The files in a DataTransfer made in the page's realm: Firefox hides from the page the items
 * another principal added.
 */
function pageTransfer(files: readonly PageFile[]): DataTransfer {
  const pageWindow = window.wrappedJSObject;
  const transfer = new pageWindow.DataTransfer();
  for (const { name, type, bytes } of files) {
    transfer.items.add(
      new pageWindow.File(cloneInto([bytes], window), name, cloneInto({ type }, window)),
    );
  }
  return transfer;
}
